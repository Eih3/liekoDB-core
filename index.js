require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const HOST = process.env.HOST || 'http://localhost';
const PORT = process.env.PORT || 6050;
const HIDE_PANEL = process.env.HIDE_PANEL === 'true';
const PANEL_ROUTE = HIDE_PANEL ? (process.env.PANEL_ROUTE || crypto.randomBytes(4).toString('hex')) : '';
const isRegisterEnabled = process.env.ENABLE_ACCOUNT_CREATION !== 'false';

const ERROR_CODES = {
    // Authentication and Authorization (400-403)
    NO_TOKEN_PROVIDED: { code: 'NO_TOKEN_PROVIDED', status: 401, message: 'No authentication token provided' },
    INVALID_TOKEN: { code: 'INVALID_TOKEN', status: 401, message: 'Invalid or expired token' },
    FORBIDDEN: { code: 'FORBIDDEN', status: 403, message: 'Insufficient permissions for operation' },
    INVALID_CREDENTIALS: { code: 'INVALID_CREDENTIALS', status: 401, message: 'Invalid username or password' },
    REGISTRATION_DISABLED: { code: 'REGISTRATION_DISABLED', status: 403, message: 'Account registration is disabled' },
    USERNAME_EXISTS: { code: 'USERNAME_EXISTS', status: 409, message: 'Username already exists' },
    EMAIL_EXISTS: { code: 'EMAIL_EXISTS', status: 409, message: 'Email already exists' },
    // Validation Errors (400)
    INVALID_REQUEST_BODY: { code: 'INVALID_REQUEST_BODY', status: 400, message: 'Invalid request body' },
    INVALID_ID_FORMAT: { code: 'INVALID_ID_FORMAT', status: 400, message: 'Invalid ID format. Only letters, numbers, underscores, and hyphens allowed' },
    INVALID_FILTER: { code: 'INVALID_FILTER', status: 400, message: 'Invalid filter JSON' },
    MISSING_REQUIRED_FIELDS: { code: 'MISSING_REQUIRED_FIELDS', status: 400, message: 'Missing required fields' },
    INVALID_TOKEN_PERMISSIONS: { code: 'INVALID_TOKEN_PERMISSIONS', status: 400, message: 'Invalid token permissions' },
    INVALID_PROJECT_NAME: { code: 'INVALID_PROJECT_NAME', status: 400, message: 'Project name is required and cannot be empty' },
    INVALID_ROLE: { code: 'INVALID_ROLE', status: 400, message: 'Invalid user role' },
    INVALID_FIELD: { code: 'INVALID_FIELD', status: 400, message: 'Invalid field name or value' },
    // Resource Not Found (404)
    PROJECT_NOT_FOUND: { code: 'PROJECT_NOT_FOUND', status: 404, message: 'Project not found' },
    COLLECTION_NOT_FOUND: { code: 'COLLECTION_NOT_FOUND', status: 404, message: 'Collection not found' },
    RECORD_NOT_FOUND: { code: 'RECORD_NOT_FOUND', status: 404, message: 'Record not found' },
    USER_NOT_FOUND: { code: 'USER_NOT_FOUND', status: 404, message: 'User not found' },
    TOKEN_NOT_FOUND: { code: 'TOKEN_NOT_FOUND', status: 404, message: 'Token not found' },
    // Conflicts (409)
    RECORD_EXISTS: { code: 'RECORD_EXISTS', status: 409, message: 'Record already exists' },
    // Rate Limiting (429)
    RATE_LIMIT_EXCEEDED: { code: 'RATE_LIMIT_EXCEEDED', status: 429, message: 'Too many requests from this IP' },
    // Server Errors (500)
    FILE_SYSTEM_ERROR: { code: 'FILE_SYSTEM_ERROR', status: 500, message: 'File system operation failed' },
    JSON_PARSING_ERROR: { code: 'JSON_PARSING_ERROR', status: 500, message: 'Failed to parse JSON data' },
    COLLECTION_CREATION_FAILED: { code: 'COLLECTION_CREATION_FAILED', status: 500, message: 'Failed to create collection' },
    REGISTRATION_ERROR: { code: 'REGISTRATION_ERROR', status: 500, message: 'Failed to register collection or project' },
    DATABASE_ERROR: { code: 'DATABASE_ERROR', status: 500, message: 'Internal database error' },
    SERVER_ERROR: { code: 'SERVER_ERROR', status: 500, message: 'Internal server error' }
};

class LiekoDBCore {
    constructor() {
        this.app = express();
        this.storageDir = path.join(__dirname, 'storage');
        this.manageDBFile = path.join(this.storageDir, 'manageDB.json');
        this.projectsDir = path.join(this.storageDir, 'projects');
        this.jwtSecret = process.env.JWT_SECRET || 'secret';
        this.writeLocks = new Map();
        this.collectionCache = new Map();
        this.initialize();
    }

    isValidId(id) {
        return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
    }

    async initialize() {
        await this.ensureDirectories();
        await this.ensureManageDBFile();
        await this.initializeCollectionCache();
        this.setupMiddleware();
        this.setupRoutes();
    }

    async initializeCollectionCache() {
        try {
            const data = await this.readManageDB();
            for (const project of data.projects) {
                const collections = new Set(project.collections?.map(c => c.name) || []);
                this.collectionCache.set(project.id, collections);
            }
        } catch (error) {
            console.error('Failed to initialize collection cache:', error);
            throw Object.assign(new Error('Failed to initialize collection cache'), ERROR_CODES.DATABASE_ERROR);
        }
    }

    async ensureDirectories() {
        try {
            await fs.mkdir(this.storageDir, { recursive: true });
            await fs.mkdir(this.projectsDir, { recursive: true });
        } catch (error) {
            console.error('Failed to create directories:', error);
            throw Object.assign(new Error('Failed to create storage directories'), ERROR_CODES.FILE_SYSTEM_ERROR);
        }
    }

    async ensureManageDBFile() {
        try {
            await fs.access(this.manageDBFile);
        } catch {
            console.log('Creating manageDB file...');
            const defaultData = {
                users: [{
                    id: uuidv4(),
                    username: process.env.ADMIN_USERNAME || 'admin',
                    email: process.env.ADMIN_MAIL || 'admin@localhost',
                    password: await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 12),
                    role: 'admin',
                    createdAt: new Date().toISOString(),
                    lastLogin: null
                }],
                projects: [],
                tokens: []
            };
            await this.writeJsonFile(this.manageDBFile, defaultData);
            console.log('✅ Created manageDB file with default admin user');
            console.log('📁 manageDB file location:', this.manageDBFile);
        }
    }

    setupMiddleware() {
        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 500,
            message: ERROR_CODES.RATE_LIMIT_EXCEEDED
        });

        this.app.use(limiter);
        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.urlencoded({ extended: true }));
        this.app.set('view engine', 'ejs');
        this.app.set('views', path.join(__dirname, './src/views'));
        this.app.use(express.static(path.join(__dirname, './src/public')));

        // CORS
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
            } else {
                next();
            }
        });

        // Request logging
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
            next();
        });
    }

    setupRoutes() {
        // Utility Routes
        this.app.get('/api/health', async (req, res) => {
            res.json({
                status: 'healthy',
                service: 'liekodb-core',
                timestamp: new Date().toISOString(),
                version: '1.0.0'
            });
        });

        this.app.get('/api/ping', (req, res) => {
            res.json({ status: 'ok', timestamp: new Date().toISOString() });
        });

        // Auth Routes
        this.app.post('/api/auth/login', this.handleLogin.bind(this));
        this.app.post('/api/auth/register', this.handleRegister.bind(this));

        // Admin Routes
        this.app.get('/api/admin/users', this.authenticateUser.bind(this), this.requireAdminAccess.bind(this), this.getAdminUsers.bind(this));
        this.app.get('/api/admin/projects', this.authenticateUser.bind(this), this.requireAdminAccess.bind(this), this.getAllProjects.bind(this));
        this.app.delete('/api/admin/users/:userId', this.authenticateUser.bind(this), this.requireAdminAccess.bind(this), this.deleteUser.bind(this));
        this.app.put('/api/admin/users/:userId/role', this.authenticateUser.bind(this), this.requireAdminAccess.bind(this), this.updateUserRole.bind(this));
        this.app.delete('/api/admin/projects/:projectId', this.authenticateUser.bind(this), this.requireAdminAccess.bind(this), this.deleteProjectAdmin.bind(this));

        // User Project Routes
        this.app.get('/api/user/projects', this.authenticateUser.bind(this), this.getUserProjects.bind(this));
        this.app.delete('/api/user/projects/:projectId', this.authenticateUser.bind(this), this.deleteProject.bind(this));

        // Project Routes
        this.app.get('/api/projects/:projectId', this.authenticateProjectToken.bind(this), this.requireReadAccess.bind(this), this.getProjectDetails.bind(this));
        this.app.post('/api/projects', this.authenticateUser.bind(this), this.createProject.bind(this));

        // Project Tokens Routes
        this.app.get('/api/token/validate', this.validateProjectToken.bind(this));
        this.app.get('/api/projects/:projectId/tokens', this.authenticateUser.bind(this), this.getProjectTokens.bind(this));
        this.app.post('/api/projects/:projectId/tokens', this.authenticateUser.bind(this), this.createProjectToken.bind(this));
        this.app.delete('/api/projects/:projectId/tokens/:tokenId', this.authenticateUser.bind(this), this.deleteProjectToken.bind(this));

        // Project Collections Routes
        this.app.get('/api/projects/:projectId/collections', this.authenticateProjectToken.bind(this), this.requireReadAccess.bind(this), this.getProjectCollections.bind(this));
        this.app.put('/api/projects/:projectId/collections', this.authenticateProjectToken.bind(this), this.requireWriteAccess.bind(this), this.updateProjectCollections.bind(this));
        this.app.delete('/api/projects/:projectId/collections', this.authenticateProjectToken.bind(this), this.requireFullAccess.bind(this), this.deleteProjectCollections.bind(this));

        // Collection Routes
        this.app.head('/api/collections/:collection', this.authenticateProjectToken.bind(this), this.checkCollection.bind(this));
        this.app.get('/api/collections/:collection', this.authenticateProjectToken.bind(this), this.getCollectionRecords.bind(this));
        this.app.post('/api/collections/:collection', this.authenticateProjectToken.bind(this), this.requireWriteAccess.bind(this), this.createCollection.bind(this));
        this.app.delete('/api/collections/:collection', this.authenticateProjectToken.bind(this), this.requireFullAccess.bind(this), this.deleteCollection.bind(this));

        // Collection Actions Routes
        this.app.get('/api/collections/:collection/search', this.authenticateProjectToken.bind(this), this.searchRecords.bind(this));
        this.app.get('/api/collections/:collection/count', this.authenticateProjectToken.bind(this), this.countRecords.bind(this));
        this.app.get('/api/collections/:collection/find-one', this.authenticateProjectToken.bind(this), this.findOneRecord.bind(this));
        this.app.get('/api/collections/:collection/keys', this.authenticateProjectToken.bind(this), this.getKeys.bind(this));
        this.app.get('/api/collections/:collection/entries', this.authenticateProjectToken.bind(this), this.getEntries.bind(this));
        this.app.get('/api/collections/:collection/size', this.authenticateProjectToken.bind(this), this.getSize.bind(this));
        this.app.post('/api/collections/:collection/batch-set', this.authenticateProjectToken.bind(this), this.requireWriteAccess.bind(this), this.batchSet.bind(this));
        this.app.post('/api/collections/:collection/batch-get', this.authenticateProjectToken.bind(this), this.batchGet.bind(this));
        this.app.post('/api/collections/:collection/batch-delete', this.authenticateProjectToken.bind(this), this.requireFullAccess.bind(this), this.batchDelete.bind(this));
        this.app.post('/api/collections/:collection/batch-update', this.authenticateProjectToken.bind(this), this.requireWriteAccess.bind(this), this.batchUpdate.bind(this));
        this.app.get('/api/collections/:collection/:id', this.authenticateProjectToken.bind(this), this.getRecord.bind(this));
        this.app.put('/api/collections/:collection/:id', this.authenticateProjectToken.bind(this), this.requireWriteAccess.bind(this), this.updateRecord.bind(this));
        this.app.delete('/api/collections/:collection/:id', this.authenticateProjectToken.bind(this), this.requireFullAccess.bind(this), this.deleteRecord.bind(this));
        this.app.post('/api/collections/:collection/:id/increment', this.authenticateProjectToken.bind(this), this.requireWriteAccess.bind(this), this.incrementRecordField.bind(this));
        this.app.post('/api/collections/:collection/:id/decrement', this.authenticateProjectToken.bind(this), this.requireWriteAccess.bind(this), this.decrementRecordField.bind(this));

        this.app.get(`/${PANEL_ROUTE}`, (req, res) => {
            res.render('panel');
        });

        this.app.get(`/liekoDB.js`, (req, res) => {
            res.sendFile(path.join(__dirname, './npm/liekoDB.js'));
        });

        this.app.use('/api', (req, res, next) => {
            if (req.path.startsWith('/api')) {
                res.status(404).json(ERROR_CODES.PROJECT_NOT_FOUND);
            } else {
                next();
            }
        });

        this.app.use((error, req, res, next) => {
            console.error('Server error:', error);
            if (req.path.startsWith('/api/')) {
                res.status(error.status || 500).json({
                    error: error.message || ERROR_CODES.SERVER_ERROR.message,
                    code: error.code || ERROR_CODES.SERVER_ERROR.code,
                    status: error.status || 500
                });
            } else {
                res.status(error.status || 500).render('error', {
                    error: error.message || ERROR_CODES.SERVER_ERROR.message,
                    status: error.status || 500
                });
            }
        });
    }

    async readJsonFile(filePath) {
        try {
            const data = await fs.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            console.error(`Failed to read JSON file ${filePath}:`, error);
            throw Object.assign(new Error('Failed to read file'), ERROR_CODES.JSON_PARSING_ERROR);
        }
    }

    async writeJsonFile(filePath, data) {
        const lockKey = filePath;
        while (this.writeLocks.has(lockKey)) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        this.writeLocks.set(lockKey, true);
        try {
            console.log(`Writing to ${filePath}:`, data);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error(`Error writing to ${filePath}:`, error);
            throw Object.assign(new Error(`Failed to write to ${filePath}`), ERROR_CODES.FILE_SYSTEM_ERROR);
        } finally {
            this.writeLocks.delete(lockKey);
        }
    }

    async readManageDB() {
        const data = await this.readJsonFile(this.manageDBFile);
        return data || { users: [], projects: [], tokens: [] };
    }

    async writeManageDB(data) {
        await this.writeJsonFile(this.manageDBFile, data);
    }

    async getUsersData() {
        const data = await this.readManageDB();
        return data.users;
    }

    async saveUsers(users) {
        const data = await this.readManageDB();
        data.users = users;
        await this.writeManageDB(data);
    }

    async ensureCollection(projectId, collectionName, createIfMissing = false) {
        console.log(`Ensuring collection '${collectionName}' for project '${projectId}', createIfMissing: ${createIfMissing}`);
        const cacheKey = projectId;
        let collections = this.collectionCache.get(cacheKey);
        if (!collections) {
            collections = new Set();
            this.collectionCache.set(cacheKey, collections);
        }

        if (collections.has(collectionName)) {
            console.log(`Collection '${collectionName}' found in cache`);
            return true;
        }

        const collectionPath = path.join(this.projectsDir, projectId, `${collectionName}.json`);
        console.log(`Checking file access at ${collectionPath}`);
        try {
            await fs.access(collectionPath);
            console.log(`Collection '${collectionName}' exists`);
            collections.add(collectionName);
            await this.registerCollection(projectId, collectionName);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') {
                if (createIfMissing) {
                    console.log(`Creating new collection at ${collectionPath}`);
                    try {
                        await this.writeJsonFile(collectionPath, {});
                        collections.add(collectionName);
                        await this.registerCollection(projectId, collectionName);
                        return true;
                    } catch (err) {
                        console.error(`Failed to create collection '${collectionName}':`, err);
                        throw Object.assign(new Error(`Failed to create collection '${collectionName}'`), ERROR_CODES.COLLECTION_CREATION_FAILED);
                    }
                } else {
                    console.log(`Collection '${collectionName}' does not exist`);
                    throw Object.assign(new Error(`Collection '${collectionName}' does not exist`), ERROR_CODES.COLLECTION_NOT_FOUND);
                }
            }
            console.error(`File system error for ${collectionPath}:`, error);
            throw Object.assign(new Error(`File system error for ${collectionPath}`), ERROR_CODES.FILE_SYSTEM_ERROR);
        }
    }

    async registerCollection(projectId, collectionName) {
        console.log(`Registering collection '${collectionName}' for project '${projectId}'`);
        const manageDbPath = path.join(this.storageDir, 'manageDB.json');
        let manageDb = { projects: [] };
        try {
            try {
                const data = await fs.readFile(manageDbPath, 'utf8');
                if (data) manageDb = JSON.parse(data);
            } catch (error) {
                console.warn(`manageDB.json not found or invalid, initializing new:`, error);
            }
            let project = manageDb.projects.find(p => p.id === projectId);
            if (!project) {
                console.error(`Project '${projectId}' not found in manageDB.json`);
                throw Object.assign(new Error(`Project '${projectId}' not found`), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            if (!project.collections) project.collections = [];
            if (!project.collections.some(c => c.name === collectionName)) {
                project.collections.push({
                    name: collectionName,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
                project.updatedAt = new Date().toISOString();
            }
            console.log(`Writing manageDB.json:`, manageDb);
            await this.writeJsonFile(manageDbPath, manageDb);
        } catch (error) {
            console.error(`Error registering collection '${collectionName}':`, error);
            throw Object.assign(new Error(`Failed to register collection '${collectionName}'`), error.code ? error : ERROR_CODES.REGISTRATION_ERROR);
        }
    }

    async handleLogin(req, res) {
        try {
            const { username, password } = req.body;
            if (!username || !password) {
                throw Object.assign(new Error('Missing username or password'), ERROR_CODES.MISSING_REQUIRED_FIELDS);
            }
            console.log('Login attempt for username:', username);
            const users = await this.getUsersData();
            const user = users.find(u => u.username === username);
            if (!user) {
                throw Object.assign(new Error('Invalid credentials'), ERROR_CODES.INVALID_CREDENTIALS);
            }
            console.log('User found, checking password...');
            const passwordMatch = await bcrypt.compare(password, user.password);
            if (!passwordMatch) {
                throw Object.assign(new Error('Invalid credentials'), ERROR_CODES.INVALID_CREDENTIALS);
            }
            console.log('Login successful for user:', username);
            user.lastLogin = new Date().toISOString();
            await this.saveUsers(users);
            const token = jwt.sign(
                { userId: user.id, username: user.username, role: user.role },
                this.jwtSecret,
                { expiresIn: '24h' }
            );
            res.json({
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role
                }
            });
        } catch (error) {
            console.error('Login error:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async handleRegister(req, res) {
        if (!isRegisterEnabled) {
            throw Object.assign(new Error('Account registration is disabled'), ERROR_CODES.REGISTRATION_DISABLED);
        }
        try {
            const { username, email, password } = req.body;
            if (!username || !email || !password) {
                throw Object.assign(new Error('Missing required fields'), ERROR_CODES.MISSING_REQUIRED_FIELDS);
            }
            const users = await this.getUsersData();
            if (users.find(u => u.username === username)) {
                throw Object.assign(new Error('Username already exists'), ERROR_CODES.USERNAME_EXISTS);
            }
            if (users.find(u => u.email === email)) {
                throw Object.assign(new Error('Email already exists'), ERROR_CODES.EMAIL_EXISTS);
            }
            const hashedPassword = await bcrypt.hash(password, 12);
            const newUser = {
                id: uuidv4(),
                username,
                email,
                password: hashedPassword,
                role: 'user',
                createdAt: new Date().toISOString(),
                lastLogin: null
            };
            users.push(newUser);
            await this.saveUsers(users);
            res.status(201).json({
                message: 'User created successfully',
                user: {
                    id: newUser.id,
                    username: newUser.username,
                    email: newUser.email,
                    role: newUser.role
                }
            });
        } catch (error) {
            console.error('Registration error:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async authenticateUser(req, res, next) {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                throw Object.assign(new Error('No token provided'), ERROR_CODES.NO_TOKEN_PROVIDED);
            }
            const decoded = jwt.verify(token, this.jwtSecret);
            req.user = decoded;
            next();
        } catch (error) {
            console.error('Authentication error:', error);
            const status = error.name === 'JsonWebTokenError' ? 401 : error.status || 500;
            res.status(status).json({
                error: error.message || ERROR_CODES.INVALID_TOKEN.message,
                code: error.name === 'JsonWebTokenError' ? ERROR_CODES.INVALID_TOKEN.code : error.code || ERROR_CODES.SERVER_ERROR.code,
                status
            });
        }
    }

    async authenticateProjectToken(req, res, next) {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                throw Object.assign(new Error('No token provided'), ERROR_CODES.NO_TOKEN_PROVIDED);
            }

            // First, try to authenticate as a user JWT token
            try {
                const decoded = jwt.verify(token, this.jwtSecret);
                const data = await this.readManageDB();
                const projectId = req.params.projectId || req.projectId;
                const project = data.projects.find(p => p.id === projectId);

                if (!project) {
                    throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
                }

                if (decoded.role === 'admin' || decoded.userId === project.ownerId) {
                    req.user = decoded;
                    req.projectId = projectId;
                    req.permissions = 'full';
                    return next();
                }
            } catch (error) {
                if (error.name !== 'JsonWebTokenError') {
                    throw error;
                }
            }

            // Fallback to project token authentication
            const data = await this.readManageDB();
            const tokenData = data.tokens.find(t => t.token === token && t.active);
            if (!tokenData) {
                throw Object.assign(new Error('Invalid project token'), ERROR_CODES.INVALID_TOKEN);
            }
            req.projectId = tokenData.projectId;
            req.tokenData = tokenData;
            req.permissions = tokenData.permissions;
            next();
        } catch (error) {
            console.error('Project token authentication error:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    requireReadAccess(req, res, next) {
        if (!['read', 'write', 'full'].includes(req.permissions)) {
            res.status(403).json(ERROR_CODES.FORBIDDEN);
        } else {
            next();
        }
    }

    requireWriteAccess(req, res, next) {
        if (!['write', 'full'].includes(req.permissions)) {
            res.status(403).json(ERROR_CODES.FORBIDDEN);
        } else {
            next();
        }
    }

    requireFullAccess(req, res, next) {
        if (req.permissions !== 'full') {
            res.status(403).json(ERROR_CODES.FORBIDDEN);
        } else {
            next();
        }
    }

    requireAdminAccess(req, res, next) {
        if (req.user.role !== 'admin') {
            res.status(403).json(ERROR_CODES.FORBIDDEN);
        } else {
            next();
        }
    }

    async getUserProjects(req, res) {
        try {
            const data = await this.readManageDB();
            if (!data || !Array.isArray(data.users) || !Array.isArray(data.projects)) {
                console.error('Invalid manageDB structure:', data);
                throw Object.assign(new Error('Invalid database structure'), ERROR_CODES.DATABASE_ERROR);
            }

            const user = data.users.find(u => u.id === req.user.userId);
            if (!user) {
                throw Object.assign(new Error('User not found'), ERROR_CODES.USER_NOT_FOUND);
            }

            const projects = data.projects.filter(p => p.ownerId === req.user.userId || req.user.role === 'admin');
            res.json({ projects });
        } catch (error) {
            console.error('Failed to get user projects:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async createProject(req, res) {
        try {
            const { name, description } = req.body;
            if (!name || name.trim() === '') {
                throw Object.assign(new Error('Project name is required and cannot be empty'), ERROR_CODES.INVALID_PROJECT_NAME);
            }

            const newProject = {
                id: uuidv4(),
                name: name.trim(),
                description: description || '',
                ownerId: req.user.userId,
                collections: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            const defaultToken = {
                id: uuidv4(),
                projectId: newProject.id,
                name: 'Default Token',
                token: crypto.randomBytes(32).toString('hex'),
                permissions: 'full',
                collections: '*',
                active: true,
                createdAt: new Date().toISOString()
            };

            const data = await this.readManageDB();
            data.projects.push(newProject);
            data.tokens.push(defaultToken);
            await this.writeManageDB(data);
            await fs.mkdir(path.join(this.projectsDir, newProject.id), { recursive: true });

            this.collectionCache.set(newProject.id, new Set());

            res.status(201).json({
                token: defaultToken.token
            });
        } catch (error) {
            console.error('Failed to create project:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async deleteProject(req, res) {
        try {
            const { projectId } = req.params;
            const data = await this.readManageDB();
            const projectIndex = data.projects.findIndex(p => p.id === projectId);
            if (projectIndex === -1) {
                throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            if (data.projects[projectIndex].ownerId !== req.user.userId && req.user.role !== 'admin') {
                throw Object.assign(new Error('Not authorized to delete this project'), ERROR_CODES.FORBIDDEN);
            }
            data.projects.splice(projectIndex, 1);
            data.tokens = data.tokens.filter(t => t.projectId !== projectId);
            await this.writeManageDB(data);
            await fs.rm(path.join(this.projectsDir, projectId), { recursive: true, force: true });

            this.collectionCache.delete(projectId);
            res.status(204).send();
        } catch (error) {
            console.error('Failed to delete project:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async getProjectDetails(req, res) {
        try {
            const data = await this.readManageDB();
            const project = data.projects.find(p => p.id === req.projectId);
            if (!project) {
                throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            res.json({
                id: project.id,
                name: project.name,
                description: project.description,
                ownerId: project.ownerId,
                collections: project.collections,
                createdAt: project.createdAt,
                updatedAt: project.updatedAt
            });
        } catch (error) {
            console.error('Failed to get project details:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async getProjectTokens(req, res) {
        try {
            const data = await this.readManageDB();
            const project = data.projects.find(p => p.id === req.params.projectId);
            if (!project) {
                throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            if (project.ownerId !== req.user.userId && req.user.role !== 'admin') {
                throw Object.assign(new Error('Not authorized to view tokens'), ERROR_CODES.FORBIDDEN);
            }
            const tokens = data.tokens.filter(t => t.projectId === req.params.projectId);
            res.json({ tokens });
        } catch (error) {
            console.error('Failed to get project tokens:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async createProjectToken(req, res) {
        try {
            const { projectId } = req.params;
            const { name, permissions } = req.body;
            if (!name || !['read', 'write', 'full'].includes(permissions)) {
                throw Object.assign(new Error('Invalid token name or permissions'), ERROR_CODES.INVALID_TOKEN_PERMISSIONS);
            }
            const data = await this.readManageDB();
            const project = data.projects.find(p => p.id === projectId);
            if (!project) {
                throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            if (project.ownerId !== req.user.userId && req.user.role !== 'admin') {
                throw Object.assign(new Error('Not authorized to create tokens'), ERROR_CODES.FORBIDDEN);
            }
            const token = {
                id: uuidv4(),
                projectId,
                name: name || 'Unnamed Token',
                token: crypto.randomBytes(32).toString('hex'),
                permissions,
                collections: '*',
                active: true,
                createdAt: new Date().toISOString()
            };
            data.tokens.push(token);
            await this.writeManageDB(data);
            res.status(201).json(token);
        } catch (error) {
            console.error('Failed to create token:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async deleteProjectToken(req, res) {
        try {
            const { projectId, tokenId } = req.params;
            const data = await this.readManageDB();
            const project = data.projects.find(p => p.id === projectId);
            if (!project) {
                throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            if (project.ownerId !== req.user.userId && req.user.role !== 'admin') {
                throw Object.assign(new Error('Not authorized to delete tokens'), ERROR_CODES.FORBIDDEN);
            }
            const tokenIndex = data.tokens.findIndex(t => t.id === tokenId && t.projectId === projectId);
            if (tokenIndex === -1) {
                throw Object.assign(new Error('Token not found'), ERROR_CODES.TOKEN_NOT_FOUND);
            }
            data.tokens.splice(tokenIndex, 1);
            await this.writeManageDB(data);
            res.status(204).send();
        } catch (error) {
            console.error('Failed to delete token:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async getAdminUsers(req, res) {
        try {
            const data = await this.readManageDB();
            const users = data.users.map(user => ({
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                createdAt: user.createdAt,
                lastLogin: user.lastLogin
            }));
            res.json({ users });
        } catch (error) {
            console.error('Failed to get users:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async getAllProjects(req, res) {
        try {
            const data = await this.readManageDB();
            res.json({ projects: data.projects });
        } catch (error) {
            console.error('Failed to get projects:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async deleteUser(req, res) {
        try {
            const { userId } = req.params;
            const data = await this.readManageDB();
            const userIndex = data.users.findIndex(u => u.id === userId);
            if (userIndex === -1) {
                throw Object.assign(new Error('User not found'), ERROR_CODES.USER_NOT_FOUND);
            }
            if (data.users[userIndex].role === 'admin' && req.user.id !== userId) {
                throw Object.assign(new Error('Cannot delete another admin'), ERROR_CODES.FORBIDDEN);
            }
            data.users.splice(userIndex, 1);
            data.projects = data.projects.filter(p => p.ownerId !== userId);
            data.tokens = data.tokens.filter(t => !data.projects.some(p => p.id === t.projectId));
            await this.writeManageDB(data);
            data.projects.forEach(p => this.collectionCache.delete(p.id));
            res.status(204).send();
        } catch (error) {
            console.error('Failed to delete user:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async updateUserRole(req, res) {
        try {
            const { userId } = req.params;
            const { role } = req.body;
            if (!['user', 'admin'].includes(role)) {
                throw Object.assign(new Error('Invalid role'), ERROR_CODES.INVALID_ROLE);
            }
            const data = await this.readManageDB();
            const user = data.users.find(u => u.id === userId);
            if (!user) {
                throw Object.assign(new Error('User not found'), ERROR_CODES.USER_NOT_FOUND);
            }
            user.role = role;
            await this.writeManageDB(data);
            res.json({ message: 'User role updated', user: { id: user.id, username: user.username, role } });
        } catch (error) {
            console.error('Failed to update user role:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async deleteProjectAdmin(req, res) {
        try {
            const { projectId } = req.params;
            const data = await this.readManageDB();
            const projectIndex = data.projects.findIndex(p => p.id === projectId);
            if (projectIndex === -1) {
                throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            data.projects.splice(projectIndex, 1);
            data.tokens = data.tokens.filter(t => t.projectId !== projectId);
            await this.writeManageDB(data);
            await fs.rm(path.join(this.projectsDir, projectId), { recursive: true, force: true });
            this.collectionCache.delete(projectId);
            res.status(204).send();
        } catch (error) {
            console.error('Failed to delete project:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async getProjectCollections(req, res) {
        try {
            const data = await this.readManageDB();
            const project = data.projects.find(p => p.id === req.projectId);
            if (!project) {
                throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            console.log('Returning collections for project:', req.projectId, project.collections);
            res.json({ collections: project.collections || [] });
        } catch (error) {
            console.error('Failed to get collections:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async updateProjectCollections(req, res) {
        try {
            const { collections } = req.body;
            console.log('Update collections request:', { projectId: req.projectId, collections });
            if (!Array.isArray(collections) || !collections.every(c => c.name && typeof c.name === 'string')) {
                throw Object.assign(new Error('Collections must be an array of objects with a valid name property'), ERROR_CODES.INVALID_REQUEST_BODY);
            }
            const data = await this.readManageDB();
            const project = data.projects.find(p => p.id === req.projectId);
            if (!project) {
                throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            const existingCollections = project.collections || [];
            const newCollections = collections.map(c => ({
                name: c.name.trim(),
                createdAt: c.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }));
            project.collections = [...existingCollections, ...newCollections.filter(nc => !existingCollections.some(ec => ec.name === nc.name))];
            project.updatedAt = new Date().toISOString();
            await this.writeManageDB(data);
            const cacheCollections = this.collectionCache.get(req.projectId) || new Set();
            newCollections.forEach(c => cacheCollections.add(c.name));
            this.collectionCache.set(req.projectId, cacheCollections);
            console.log('Collections updated:', project.collections);
            res.json({ collections: project.collections });
        } catch (error) {
            console.error('Failed to update collections:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async deleteProjectCollections(req, res) {
        try {
            const { collections } = req.body;
            console.log('Delete collections request:', { projectId: req.projectId, collections });
            if (!Array.isArray(collections) || !collections.every(c => c.name)) {
                throw Object.assign(new Error('Collections must be an array of objects with name property'), ERROR_CODES.INVALID_REQUEST_BODY);
            }
            const data = await this.readManageDB();
            const project = data.projects.find(p => p.id === req.projectId);
            if (!project) {
                throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            project.collections = project.collections.filter(c => !collections.some(d => d.name === c.name));
            project.updatedAt = new Date().toISOString();
            await this.writeManageDB(data);
            const cacheCollections = this.collectionCache.get(req.projectId) || new Set();
            collections.forEach(c => cacheCollections.delete(c.name));
            this.collectionCache.set(req.projectId, cacheCollections);
            for (const collection of collections) {
                const collectionPath = path.join(this.projectsDir, req.projectId, `${collection.name}.json`);
                await fs.unlink(collectionPath).catch(() => { });
            }
            console.log('Collections deleted, remaining:', project.collections);
            res.status(204).send();
        } catch (error) {
            console.error('Failed to delete collections:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async validateProjectToken(req, res) {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                throw Object.assign(new Error('No token provided'), ERROR_CODES.NO_TOKEN_PROVIDED);
            }
            const data = await this.readManageDB();
            const tokenData = data.tokens.find(t => t.token === token && t.active);
            if (!tokenData) {
                throw Object.assign(new Error('Invalid token'), ERROR_CODES.INVALID_TOKEN);
            }
            const project = data.projects.find(p => p.id === tokenData.projectId);
            if (!project) {
                throw Object.assign(new Error('Project not found'), ERROR_CODES.PROJECT_NOT_FOUND);
            }
            res.json({
                project: {
                    id: project.id,
                    name: project.name,
                    createdAt: project.createdAt,
                    updatedAt: project.updatedAt
                },
                name: tokenData.name,
                permissions: tokenData.permissions,
                collections: project.collections || []
            });
        } catch (error) {
            console.error('Token validation error:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async checkCollection(req, res) {
        try {
            const { collection } = req.params;
            await this.ensureCollection(req.projectId, collection);
            res.status(200).send();
        } catch (error) {
            console.error('Collection check error:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async getCollectionRecords(req, res) {
        try {
            const { collection } = req.params;
            await this.ensureCollection(req.projectId, collection, false);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};
            let records = Object.values(data);

            if (req.query.filter) {
                try {
                    const filter = JSON.parse(req.query.filter);
                    records = records.filter(record => matchFilter(record, filter));
                } catch (err) {
                    throw Object.assign(new Error('Invalid filter JSON'), ERROR_CODES.INVALID_FILTER);
                }
            }

            if (req.query.fields) {
                const fields = req.query.fields.split(',');
                records = records.map(record => {
                    const filteredRecord = {};
                    fields.forEach(field => {
                        if (field in record) {
                            filteredRecord[field] = record[field];
                        }
                    });
                    return filteredRecord;
                });
            }

            if (req.query.sort) {
                const [field, order] = req.query.sort.split(':');
                records.sort((a, b) => {
                    const aVal = a[field];
                    const bVal = b[field];
                    const result = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
                    return order === 'desc' ? -result : result;
                });
            }

            const offset = parseInt(req.query.offset) || 0;
            const limit = parseInt(req.query.limit) || records.length;
            const totalCount = records.length;
            const actualPage = limit > 0 ? Math.floor(offset / limit) + 1 : 1;
            const maxPage = limit > 0 ? Math.ceil(totalCount / limit) : 1;

            records = records.slice(offset, offset + limit);

            res.json({
                data: records,
                totalCount,
                actualPage,
                maxPage
            });
        } catch (error) {
            console.error('Failed to get collection records:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async createCollection(req, res) {
        try {
            const { collection } = req.params;
            console.log(`Creating collection '${collection}' for project '${req.projectId}' with data:`, req.body);

            // Validate payload
            if (!req.body || typeof req.body !== 'object') {
                throw Object.assign(new Error('Invalid request body'), ERROR_CODES.INVALID_REQUEST_BODY);
            }

            // Ensure collection
            await this.ensureCollection(req.projectId, collection, true);

            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            console.log(`Reading collection at ${collectionPath}`);
            let data = await this.readJsonFile(collectionPath) || {};

            const record = {
                ...req.body,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            if (!record.id) {
                record.id = uuidv4();
                console.log(`Generated ID for record: ${record.id}`);
            }

            if (!this.isValidId(record.id)) {
                console.log(`Invalid ID format for record ID: ${record.id}`);
                throw Object.assign(new Error('Invalid ID format'), ERROR_CODES.INVALID_ID_FORMAT);
            }

            if (data[record.id]) {
                console.log(`Record '${record.id}' already exists in '${collection}'`);
                throw Object.assign(new Error(`Record '${record.id}' already exists`), ERROR_CODES.RECORD_EXISTS);
            }

            data[record.id] = record;
            console.log(`Writing record to ${collectionPath}:`, data);
            await this.writeJsonFile(collectionPath, data);

            res.status(201).json({
                results: [{
                    id: record.id,
                    status: 'success',
                    record
                }],
                errors: [],
                total: 1
            });
        } catch (error) {
            console.error(`Error in createCollection for '${req.params.collection}':`, error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async deleteCollection(req, res) {
        try {
            const { collection } = req.params;
            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            await this.writeJsonFile(collectionPath, {});
            const cacheCollections = this.collectionCache.get(req.projectId) || new Set();
            cacheCollections.delete(collection);
            this.collectionCache.set(req.projectId, cacheCollections);
            const data = await this.readManageDB();
            const project = data.projects.find(p => p.id === req.projectId);
            if (project) {
                project.collections = project.collections.filter(c => c.name !== collection);
                project.updatedAt = new Date().toISOString();
                await this.writeManageDB(data);
            }
            res.status(204).send();
        } catch (error) {
            console.error('Failed to delete collection:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async getRecord(req, res) {
        try {
            const { collection, id } = req.params;
            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath);

            if (!data || !data[id]) {
                throw Object.assign(new Error(`No Record found, ${collection} with ID ${id}`), ERROR_CODES.RECORD_NOT_FOUND);
            }

            let record = data[id];

            if (req.query.fields) {
                const fields = req.query.fields.split(',');
                const filteredRecord = {};
                fields.forEach(field => {
                    if (field in record) {
                        filteredRecord[field] = record[field];
                    }
                });
                record = filteredRecord;
            }

            res.json(record);
        } catch (error) {
            console.error('Failed to get record:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async updateRecord(req, res) {
        try {
            const { collection, id } = req.params;
            if (!this.isValidId(id)) {
                throw Object.assign(new Error('Invalid ID format'), ERROR_CODES.INVALID_ID_FORMAT);
            }

            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};

            if (!data[id]) {
                throw Object.assign(new Error(`Record not found in '${collection}'`), ERROR_CODES.RECORD_NOT_FOUND);
            }

            const record = {
                ...data[id],
                ...req.body,
                id,
                updatedAt: new Date().toISOString(),
                createdAt: data[id].createdAt || new Date().toISOString()
            };

            data[id] = record;
            await this.writeJsonFile(collectionPath, data);

            res.json({
                results: [{
                    id,
                    status: 'success',
                    record
                }],
                errors: [],
                total: 1
            });
        } catch (error) {
            console.error('Failed to update record:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async deleteRecord(req, res) {
        try {
            const { collection, id } = req.params;
            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};
            if (!data[id]) {
                res.status(204).send();
            } else {
                delete data[id];
                await this.writeJsonFile(collectionPath, data);
                res.status(204).send();
            }
        } catch (error) {
            console.error('Failed to delete record:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async searchRecords(req, res) {
        try {
            const { collection } = req.params;
            await this.ensureCollection(req.projectId, collection);
            const { term, fields } = req.query;
            if (!term) {
                throw Object.assign(new Error('Search term required'), ERROR_CODES.MISSING_REQUIRED_FIELDS);
            }
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath) || {};
            let records = Object.values(data);
            const searchFields = fields ? fields.split(',') : Object.keys(records[0] || {});
            const searchTerm = term.toLowerCase();
            records = records.filter(record => {
                return searchFields.some(field => {
                    const value = record[field];
                    return value && typeof value === 'string' && value.toLowerCase().includes(searchTerm);
                });
            });
            if (req.query.sort) {
                const [field, order] = req.query.sort.split(':');
                records.sort((a, b) => {
                    const aVal = a[field];
                    const bVal = b[field];
                    const result = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
                    return order === 'desc' ? -result : result;
                });
            }
            if (req.query.fields) {
                const fields = req.query.fields.split(',');
                records = records.map(record => {
                    const filtered = {};
                    for (const field of fields) {
                        if (field in record) {
                            filtered[field] = record[field];
                        }
                    }
                    return filtered;
                });
            }
            const offset = parseInt(req.query.offset) || 0;
            const limit = parseInt(req.query.limit) || records.length;
            const totalCount = records.length;
            records = records.slice(offset, offset + limit);
            res.json({ data: records, totalCount });
        } catch (error) {
            console.error('Failed to search collection:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async countRecords(req, res) {
        try {
            const { collection } = req.params;
            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};
            let records = Object.values(data);
            if (req.query.filter) {
                console.log('[DEBUG] raw filter:', req.query.filter);
                try {
                    const filter = JSON.parse(req.query.filter);
                    records = records.filter(record => matchFilter(record, filter));
                } catch (err) {
                    throw Object.assign(new Error('Invalid filter JSON'), ERROR_CODES.INVALID_FILTER);
                }
            }
            res.json({ count: records.length });
        } catch (error) {
            console.error('Failed to count collection:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async findOneRecord(req, res) {
        try {
            const { collection } = req.params;
            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};
            let filter;
            try {
                filter = req.query.filter ? JSON.parse(req.query.filter) : {};
            } catch (error) {
                throw Object.assign(new Error('Invalid filter format'), ERROR_CODES.INVALID_FILTER);
            }
            const records = Object.values(data);
            const result = records.find(record => matchFilter(record, filter));
            res.json(result || null);
        } catch (error) {
            console.error('Failed to find record:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async getKeys(req, res) {
        try {
            const { collection } = req.params;
            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath) || {};
            const keys = Object.keys(data);
            res.json({ keys });
        } catch (error) {
            console.error('Failed to get collection keys:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async getEntries(req, res) {
        try {
            const { collection } = req.params;
            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath) || {};
            const entries = Object.entries(data).map(([id, record]) => ({ id, ...record }));
            res.json({ entries });
        } catch (error) {
            console.error('Failed to get collection entries:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async getSize(req, res) {
        try {
            const { collection } = req.params;
            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath) || {};
            const size = Object.keys(data).length;
            res.json({ size });
        } catch (error) {
            console.error('Failed to get collection size:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async batchSet(req, res) {
        try {
            const { collection } = req.params;
            const { records } = req.body;
            if (!Array.isArray(records) || records.length === 0) {
                throw Object.assign(new Error('Records must be a non-empty array'), ERROR_CODES.INVALID_REQUEST_BODY);
            }

            await this.ensureCollection(req.projectId, collection, true);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};

            const results = [];
            const errors = [];

            for (const record of records) {
                if (!record || typeof record !== 'object') {
                    errors.push({
                        id: record?.id || null,
                        error: 'Invalid record format',
                        code: ERROR_CODES.INVALID_REQUEST_BODY.code,
                        status: 400
                    });
                    continue;
                }

                const newRecord = {
                    ...record,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                if (!newRecord.id) {
                    newRecord.id = uuidv4();
                }

                if (!this.isValidId(newRecord.id)) {
                    errors.push({
                        id: newRecord.id,
                        error: 'Invalid ID format',
                        code: ERROR_CODES.INVALID_ID_FORMAT.code,
                        status: 400
                    });
                    continue;
                }

                if (data[newRecord.id]) {
                    errors.push({
                        id: newRecord.id,
                        error: `Record '${newRecord.id}' already exists`,
                        code: ERROR_CODES.RECORD_EXISTS.code,
                        status: 409
                    });
                    continue;
                }

                data[newRecord.id] = newRecord;
                results.push({
                    id: newRecord.id,
                    status: 'success',
                    record: newRecord
                });
            }

            await this.writeJsonFile(collectionPath, data);

            res.status(201).json({
                results,
                errors,
                total: records.length
            });
        } catch (error) {
            console.error('Failed to batch set records:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async batchGet(req, res) {
        try {
            const { collection } = req.params;
            const { ids } = req.body;
            if (!Array.isArray(ids) || ids.length === 0) {
                throw Object.assign(new Error('IDs must be a non-empty array'), ERROR_CODES.INVALID_REQUEST_BODY);
            }

            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath) || {};

            const results = [];
            const errors = [];

            for (const id of ids) {
                if (!this.isValidId(id)) {
                    errors.push({
                        id,
                        error: 'Invalid ID format',
                        code: ERROR_CODES.INVALID_ID_FORMAT.code,
                        status: 400
                    });
                    continue;
                }

                if (!data[id]) {
                    errors.push({
                        id,
                        error: `Record '${id}' not found`,
                        code: ERROR_CODES.RECORD_NOT_FOUND.code,
                        status: 404
                    });
                    continue;
                }

                results.push({
                    id,
                    status: 'success',
                    record: data[id]
                });
            }

            res.json({
                results,
                errors,
                total: ids.length
            });
        } catch (error) {
            console.error('Failed to batch get records:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async batchDelete(req, res) {
        try {
            const { collection } = req.params;
            const { ids } = req.body;
            if (!Array.isArray(ids) || ids.length === 0) {
                throw Object.assign(new Error('IDs must be a non-empty array'), ERROR_CODES.INVALID_REQUEST_BODY);
            }

            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};

            const results = [];
            const errors = [];

            for (const id of ids) {
                if (!this.isValidId(id)) {
                    errors.push({
                        id,
                        error: 'Invalid ID format',
                        code: ERROR_CODES.INVALID_ID_FORMAT.code,
                        status: 400
                    });
                    continue;
                }

                if (!data[id]) {
                    results.push({
                        id,
                        status: 'success',
                        message: `Record '${id}' not found, nothing to delete`
                    });
                    continue;
                }

                delete data[id];
                results.push({
                    id,
                    status: 'success',
                    message: `Record '${id}' deleted`
                });
            }

            await this.writeJsonFile(collectionPath, data);

            res.json({
                results,
                errors,
                total: ids.length
            });
        } catch (error) {
            console.error('Failed to batch delete records:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async batchUpdate(req, res) {
        try {
            const { collection } = req.params;
            const { updates } = req.body;
            if (!Array.isArray(updates) || updates.length === 0) {
                throw Object.assign(new Error('Updates must be a non-empty array'), ERROR_CODES.INVALID_REQUEST_BODY);
            }

            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};

            const results = [];
            const errors = [];

            for (const update of updates) {
                const { id, data: updateData } = update;
                if (!this.isValidId(id)) {
                    errors.push({
                        id,
                        error: 'Invalid ID format',
                        code: ERROR_CODES.INVALID_ID_FORMAT.code,
                        status: 400
                    });
                    continue;
                }

                if (!data[id]) {
                    errors.push({
                        id,
                        error: `Record '${id}' not found`,
                        code: ERROR_CODES.RECORD_NOT_FOUND.code,
                        status: 404
                    });
                    continue;
                }

                if (!updateData || typeof updateData !== 'object') {
                    errors.push({
                        id,
                        error: 'Invalid update data',
                        code: ERROR_CODES.INVALID_REQUEST_BODY.code,
                        status: 400
                    });
                    continue;
                }

                const record = {
                    ...data[id],
                    ...updateData,
                    id,
                    updatedAt: new Date().toISOString(),
                    createdAt: data[id].createdAt || new Date().toISOString()
                };

                data[id] = record;
                results.push({
                    id,
                    status: 'success',
                    record
                });
            }

            await this.writeJsonFile(collectionPath, data);

            res.json({
                results,
                errors,
                total: updates.length
            });
        } catch (error) {
            console.error('Failed to batch update records:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async incrementRecordField(req, res) {
        try {
            const { collection, id } = req.params;
            const { field, value = 1 } = req.body;
            if (!field || typeof field !== 'string') {
                throw Object.assign(new Error('Field name is required'), ERROR_CODES.MISSING_REQUIRED_FIELDS);
            }
            if (typeof value !== 'number') {
                throw Object.assign(new Error('Increment value must be a number'), ERROR_CODES.INVALID_FIELD);
            }

            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};

            if (!data[id]) {
                throw Object.assign(new Error(`Record '${id}' not found`), ERROR_CODES.RECORD_NOT_FOUND);
            }

            if (typeof data[id][field] !== 'number') {
                throw Object.assign(new Error(`Field '${field}' is not a number`), ERROR_CODES.INVALID_FIELD);
            }

            data[id][field] += value;
            data[id].updatedAt = new Date().toISOString();

            await this.writeJsonFile(collectionPath, data);

            res.json({
                results: [{
                    id,
                    status: 'success',
                    record: data[id]
                }],
                errors: [],
                total: 1
            });
        } catch (error) {
            console.error('Failed to increment field:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }

    async decrementRecordField(req, res) {
        try {
            const { collection, id } = req.params;
            const { field, value = 1 } = req.body;
            if (!field || typeof field !== 'string') {
                throw Object.assign(new Error('Field name is required'), ERROR_CODES.MISSING_REQUIRED_FIELDS);
            }
            if (typeof value !== 'number') {
                throw Object.assign(new Error('Decrement value must be a number'), ERROR_CODES.INVALID_FIELD);
            }

            await this.ensureCollection(req.projectId, collection);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};

            if (!data[id]) {
                throw Object.assign(new Error(`Record '${id}' not found`), ERROR_CODES.RECORD_NOT_FOUND);
            }

            if (typeof data[id][field] !== 'number') {
                throw Object.assign(new Error(`Field '${field}' is not a number`), ERROR_CODES.INVALID_FIELD);
            }

            data[id][field] -= value;
            data[id].updatedAt = new Date().toISOString();

            await this.writeJsonFile(collectionPath, data);

            res.json({
                results: [{
                    id,
                    status: 'success',
                    record: data[id]
                }],
                errors: [],
                total: 1
            });
        } catch (error) {
            console.error('Failed to decrement field:', error);
            res.status(error.status || 500).json({
                error: error.message || ERROR_CODES.SERVER_ERROR.message,
                code: error.code || ERROR_CODES.SERVER_ERROR.code,
                status: error.status || 500
            });
        }
    }
}

// Utility function for filtering records
function matchFilter(record, filter) {
    return Object.entries(filter).every(([key, value]) => {
        let recordValue = key.includes('.') ? key.split('.').reduce((obj, k) => obj && obj[k], record) : record[key];
        if (typeof value === 'object' && value !== null) {
            if (value.$eq !== undefined) return recordValue === value.$eq;
            if (value.$gt !== undefined) return recordValue > value.$gt;
            if (value.$gte !== undefined) return recordValue >= value.$gte;
            if (value.$lt !== undefined) return recordValue < value.$lt;
            if (value.$lte !== undefined) return recordValue <= value.$lte;
            if (value.$in !== undefined) return Array.isArray(value.$in) && value.$in.includes(recordValue);
            if (value.$regex !== undefined) return new RegExp(value.$regex).test(recordValue);
            return false;
        }
        return recordValue === value;
    });
}

const db = new LiekoDBCore();
db.app.listen(PORT, () => {
    console.log(`🚀 LiekoDB server is running on ${HOST}:${PORT}`);
    if (HIDE_PANEL) {
        console.log(`🔒 Admin panel is hidden, access it at: ${HOST}:${PORT}/${PANEL_ROUTE}`);
    } else {
        console.log(`🌐 Admin panel is accessible at: ${HOST}:${PORT}/`);
    }
});
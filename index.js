require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const HOST = process.env.HOST || 'http://localhost'
const PORT = process.env.PORT || 6050;
const PANEL_ROUTE = crypto.randomBytes(4).toString('hex')

class LiekoDBCore {
    constructor() {
        this.app = express();
        this.storageDir = path.join(__dirname, 'storage');
        this.manageDBFile = path.join(this.storageDir, 'manageDB.json');
        this.projectsDir = path.join(this.storageDir, 'projects');
        this.jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        this.writeLocks = new Map();
        this.initialize();
    }

    async initialize() {
        await this.ensureDirectories();
        await this.ensureManageDBFile();
        this.setupMiddleware();
        this.setupRoutes();
    }

    async ensureDirectories() {
        try {
            await fs.mkdir(this.storageDir, { recursive: true });
            await fs.mkdir(this.projectsDir, { recursive: true });
            //console.log('Storage directories ensured');
        } catch (error) {
            console.error('Failed to create directories:', error);
        }
    }

    async ensureManageDBFile() {
        try {
            await fs.access(this.manageDBFile);
            //console.log('manageDB file exists');
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
            message: { error: 'Too many requests from this IP', status: 429 }
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
        this.app.get('/api/debug/users', async (req, res) => {
            try {
                const users = await this.getUsersData();
                res.json({
                    userCount: users.length,
                    users: users.map(u => ({
                        username: u.username,
                        email: u.email,
                        role: u.role,
                        hasPassword: !!u.password
                    }))
                });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch users', status: 500 });
            }
        });

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

        this.app.post('/api/auth/login', this.handleLogin.bind(this));
        this.app.post('/api/auth/register', this.handleRegister.bind(this));

        this.app.get('/api/token/validate', this.validateProjectToken.bind(this));

        this.app.get('/api/projects/:projectId/tokens', this.authenticateUser.bind(this), this.getProjectTokens.bind(this));
        this.app.post('/api/projects/:projectId/tokens', this.authenticateUser.bind(this), this.createProjectToken.bind(this));
        this.app.delete('/api/projects/:projectId/tokens/:tokenId', this.authenticateUser.bind(this), this.deleteProjectToken.bind(this));
        this.app.get('/api/projects/:projectId', this.authenticateProjectToken.bind(this), async (req, res) => {
            try {
                const { projectId } = req.params;
                const data = await this.readManageDB();
                const project = data.projects.find(p => p.id === projectId);
                if (!project) {
                    return res.status(404).json({ error: 'Project not found', status: 404 });
                }
                res.json({ id: project.id, name: project.name, description: project.description });
            } catch (error) {
                res.status(error.status || 500).json({ error: error.message || 'Internal server error', status: error.status || 500 });
            }
        });

        this.app.head('/api/collections/:collection', this.authenticateProjectToken.bind(this), this.checkCollection.bind(this));
        this.app.get('/api/collections/:collection', this.authenticateProjectToken.bind(this), this.getCollection.bind(this));
        this.app.post('/api/collections/:collection', this.authenticateProjectToken.bind(this), this.requireWriteAccess.bind(this), this.createRecord.bind(this));
        this.app.delete('/api/collections/:collection', this.authenticateProjectToken.bind(this), this.requireFullAccess.bind(this), this.clearCollection.bind(this));
        this.app.get('/api/collections/:collection/search', this.authenticateProjectToken.bind(this), this.searchCollection.bind(this));
        this.app.get('/api/collections/:collection/count', this.authenticateProjectToken.bind(this), this.countCollection.bind(this));
        this.app.get('/api/collections/:collection/find-one', this.authenticateProjectToken.bind(this), this.findOne.bind(this));
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
        this.app.post('/api/collections/:collection/:id/increment', this.authenticateProjectToken.bind(this), this.requireWriteAccess.bind(this), this.incrementField.bind(this));
        this.app.put('/api/projects/:projectId/collections', this.authenticateProjectToken.bind(this), this.requireWriteAccess.bind(this), this.updateProjectCollections.bind(this));
        this.app.get('/api/admin/users', this.authenticateUser.bind(this), this.requireAdmin.bind(this), this.getAdminUsers.bind(this));
        this.app.get('/api/admin/projects', this.authenticateUser.bind(this), this.requireAdmin.bind(this), this.getAllProjects.bind(this));
        this.app.delete('/api/admin/users/:userId', this.authenticateUser.bind(this), this.requireAdmin.bind(this), this.deleteUser.bind(this));
        this.app.put('/api/admin/users/:userId/role', this.authenticateUser.bind(this), this.requireAdmin.bind(this), this.updateUserRole.bind(this));
        this.app.delete('/api/admin/projects/:projectId', this.authenticateUser.bind(this), this.requireAdmin.bind(this), this.deleteProjectAdmin.bind(this));
        this.app.get('/api/user/projects', this.authenticateUser.bind(this), this.getUserProjects.bind(this));
        this.app.post('/api/user/projects', this.authenticateUser.bind(this), this.createProject.bind(this));
        this.app.delete('/api/user/projects/:projectId', this.authenticateUser.bind(this), this.deleteProject.bind(this));

        //this.app.get(`/`, (req, res) => { // Replace if you want to open panel inscription to public
        this.app.get(`/${PANEL_ROUTE}`, (req, res) => {
            res.render('panel');
        });

        this.app.get(`/liekoDB.js`, (req, res) => {
            res.sendFile(path.join(__dirname, './npm/liekoDB.js'));
        });

        this.app.use('/api', (req, res, next) => {
            if (req.path.startsWith('/api')) {
                res.status(404).json({ error: 'API endpoint not found', status: 404 });
            } else {
                next();
            }
        });

        // General error handling middleware
        this.app.use((error, req, res, next) => {
            console.error('Server error:', error);
            if (req.path.startsWith('/api/')) {
                res.status(error.status || 500).json({ error: error.message || 'Internal server error', status: error.status || 500 });
            } else {
                res.status(error.status || 500).render('error', {
                    error: error.message || 'Internal server error',
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
            const err = new Error('Failed to read file');
            err.status = 500;
            throw err;
        }
    }

    async writeJsonFile(filePath, data) {
        const lockKey = filePath;
        while (this.writeLocks.has(lockKey)) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        this.writeLocks.set(lockKey, true);
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            const err = new Error('Failed to write file');
            err.status = 500;
            throw err;
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

    async handleLogin(req, res) {
        try {
            const { username, password } = req.body;
            console.log('Login attempt for username:', username);
            const users = await this.getUsersData();
            const user = users.find(u => u.username === username);
            if (!user) {
                const error = new Error('Invalid credentials');
                error.status = 401;
                throw error;
            }
            console.log('User found, checking password...');
            const passwordMatch = await bcrypt.compare(password, user.password);
            if (!passwordMatch) {
                const error = new Error('Invalid credentials');
                error.status = 401;
                throw error;
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
            res.status(error.status || 500).json({ error: error.message || 'Internal server error', status: error.status || 500 });
        }
    }

    async handleRegister(req, res) {
        try {
            const { username, email, password } = req.body;
            if (!username || !email || !password) {
                const error = new Error('Missing required fields');
                error.status = 400;
                throw error;
            }
            const users = await this.getUsersData();
            if (users.find(u => u.username === username)) {
                const error = new Error('Username already exists');
                error.status = 409;
                throw error;
            }
            if (users.find(u => u.email === email)) {
                const error = new Error('Email already exists');
                error.status = 409;
                throw error;
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
            res.status(error.status || 500).json({ error: error.message || 'Internal server error', status: error.status || 500 });
        }
    }

    async authenticateUser(req, res, next) {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                const error = new Error('No token provided');
                error.status = 401;
                throw error;
            }
            const decoded = jwt.verify(token, this.jwtSecret);
            req.user = decoded;
            next();
        } catch (error) {
            error.status = error.name === 'JsonWebTokenError' ? 401 : error.status || 500;
            res.status(error.status).json({ error: error.message || 'Authentication failed', status: error.status });
        }
    }

    async authenticateProjectToken(req, res, next) {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                const error = new Error('No project token provided');
                error.status = 401;
                throw error;
            }
            const data = await this.readManageDB();
            const tokenData = data.tokens.find(t => t.token === token && t.active);
            if (!tokenData) {
                const error = new Error('Invalid project token');
                error.status = 401;
                throw error;
            }
            req.projectId = tokenData.projectId;
            req.tokenData = tokenData;
            req.permissions = tokenData.permissions;
            next();
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Authentication failed', status: error.status || 500 });
        }
    }

    requireWriteAccess(req, res, next) {
        if (!['write', 'full'].includes(req.permissions)) {
            res.status(403).json({ error: 'Write access required', status: 403 });
        } else {
            next();
        }
    }

    requireFullAccess(req, res, next) {
        if (req.permissions !== 'full') {
            res.status(403).json({ error: 'Full access required', status: 403 });
        } else {
            next();
        }
    }

    requireAdmin(req, res, next) {
        if (req.user.role !== 'admin') {
            res.status(403).json({ error: 'Admin access required', status: 403 });
        } else {
            next();
        }
    }

    async validateProjectToken(req, res) {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                const error = new Error('No token provided');
                error.status = 401;
                throw error;
            }
            const data = await this.readManageDB();
            const tokenData = data.tokens.find(t => t.token === token && t.active);
            if (!tokenData) {
                const error = new Error('Invalid token');
                error.status = 401;
                throw error;
            }
            const project = data.projects.find(p => p.id === tokenData.projectId);
            if (!project) {
                const error = new Error('Project not found');
                error.status = 404;
                throw error;
            }
            console.log('Valid token found:', tokenData);
            res.json({
                projectId: tokenData.projectId,
                permissions: tokenData.permissions,
                collections: project.collections || []
            });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Internal server error', status: error.status || 500 });
        }
    }

    async checkCollection(req, res) {
        try {
            const { collection } = req.params;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            await fs.access(collectionPath);
            res.status(200).send();
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'Collection not found', status: 404 });
            } else {
                res.status(500).json({ error: 'Collection check failed', status: 500 });
            }
        }
    }

    async getCollection(req, res) {
        try {
            const { collection } = req.params;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath) || {};
            let records = Object.values(data);
            if (req.query.filter) {
                const filter = JSON.parse(req.query.filter);
                records = records.filter(record => {
                    return Object.entries(filter).every(([key, value]) => record[key] === value);
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
            records = records.slice(offset, offset + limit);
            res.json({ data: records, totalCount });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get collection', status: 500 });
        }
    }

    async getRecord(req, res) {
        try {
            const { collection, id } = req.params;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath);
            if (!data || !data[id]) {
                res.status(404).json({ error: `No Record found, ${collection} with ID ${id}`, status: 404 });
            } else {
                res.json(data[id]);
            }
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to get record', status: error.status || 500 });
        }
    }

    async createRecord(req, res) {
        try {
            const { collection } = req.params;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};
            const record = {
                ...req.body,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            if (!record.id) {
                record.id = uuidv4();
            }
            data[record.id] = record;
            await this.writeJsonFile(collectionPath, data);
            res.status(201).json(record);
        } catch (error) {
            res.status(500).json({ error: 'Failed to create record', status: 500 });
        }
    }

    async updateRecord(req, res) {
        try {
            const { collection, id } = req.params;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};
            if (!data[id]) {
                res.status(404).json({ error: 'Record not found', status: 404 });
            } else {
                const record = {
                    ...data[id],
                    ...req.body,
                    id,
                    updatedAt: new Date().toISOString(),
                    createdAt: data[id].createdAt || new Date().toISOString()
                };
                data[id] = record;
                await this.writeJsonFile(collectionPath, data);
                res.json(record);
            }
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to update record', status: error.status || 500 });
        }
    }

    async deleteRecord(req, res) {
        try {
            const { collection, id } = req.params;
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
            res.status(500).json({ error: 'Failed to delete record', status: 500 });
        }
    }

    async clearCollection(req, res) {
        try {
            const { collection } = req.params;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            await this.writeJsonFile(collectionPath, {});
            res.status(204).send();
        } catch (error) {
            res.status(500).json({ error: 'Failed to clear collection', status: 500 });
        }
    }

    async searchCollection(req, res) {
        try {
            const { collection } = req.params;
            const { term, fields } = req.query;
            if (!term) {
                res.status(400).json({ error: 'Search term required', status: 400 });
            } else {
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
                const offset = parseInt(req.query.offset) || 0;
                const limit = parseInt(req.query.limit) || records.length;
                const totalCount = records.length;
                records = records.slice(offset, offset + limit);
                res.json({ data: records, totalCount });
            }
        } catch (error) {
            res.status(500).json({ error: 'Failed to search collection', status: 500 });
        }
    }

    async countCollection(req, res) {
        try {
            const { collection } = req.params;
            console.log(`Counting records in collection: ${collection}`);
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data;
            try {
                data = await this.readJsonFile(collectionPath) || {};
            } catch (error) {
                if (error.code === 'ENOENT') {
                    data = {};
                } else {
                    res.status(500).json({ error: 'Failed to read collection file', status: 500 });
                }
            }
            let records = Object.values(data);
            if (req.query.filter) {
                try {
                    const filter = JSON.parse(req.query.filter);
                    records = records.filter(record => {
                        return Object.entries(filter).every(([key, value]) => record[key] === value);
                    });
                } catch (error) {
                    res.status(400).json({ error: 'Invalid filter format', status: 400 });
                }
            }
            res.json({ count: records.length });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to count collection', status: error.status || 500 });
        }
    }

    async findOne(req, res) {
        try {
            const { collection } = req.params;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data;
            try {
                data = await this.readJsonFile(collectionPath) || {};
            } catch (error) {
                if (error.code === 'ENOENT') {
                    data = {};
                } else {
                    res.status(500).json({ error: 'Failed to read collection file', status: 500 });
                }
            }
            let filter;
            try {
                filter = req.query.filter ? JSON.parse(req.query.filter) : {};
            } catch (error) {
                res.status(400).json({ error: 'Invalid filter format', status: 400 });
            }
            const records = Object.values(data);
            const result = records.find(record => {
                return Object.entries(filter).every(([key, value]) => {
                    let recordValue = key.includes('.') ? key.split('.').reduce((obj, k) => obj && obj[k], record) : record[key];
                    if (typeof value === 'object' && value !== null) {
                        if (value.$gt) return recordValue > value.$gt;
                        if (value.$lte) return recordValue <= value.$lte;
                        if (value.$in) return value.$in.includes(recordValue);
                        if (value.$regex) return new RegExp(value.$regex).test(recordValue);
                        return false;
                    }
                    return recordValue === value;
                });
            });
            res.json(result || null);
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to find record', status: error.status || 500 });
        }
    }

    async getKeys(req, res) {
        try {
            const { collection } = req.params;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath) || {};
            const keys = Object.keys(data);
            res.json({ keys });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get keys', status: 500 });
        }
    }

    async getEntries(req, res) {
        try {
            const { collection } = req.params;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath) || {};
            const entries = Object.entries(data);
            res.json({ entries });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get entries', status: 500 });
        }
    }

    async getSize(req, res) {
        try {
            const { collection } = req.params;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            const data = await this.readJsonFile(collectionPath) || {};
            res.json({ size: Object.keys(data).length });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get collection size', status: 500 });
        }
    }

    async batchSet(req, res) {
        try {
            const { collection } = req.params;
            const { records } = req.body;
            if (!Array.isArray(records)) {
                res.status(400).json({ error: 'Records must be an array', status: 400 });
            } else {
                const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
                let data = await this.readJsonFile(collectionPath) || {};
                const results = [];
                const errors = [];
                for (const record of records) {
                    try {
                        const id = record.id || uuidv4();
                        const newRecord = {
                            ...record,
                            id,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        };
                        data[id] = newRecord;
                        results.push({ id, status: 'success', record: newRecord });
                    } catch (err) {
                        errors.push({ id: record.id, error: err.message });
                    }
                }
                await this.writeJsonFile(collectionPath, data);
                res.status(201).json({ results, errors, total: records.length });
            }
        } catch (error) {
            res.status(500).json({ error: 'Failed to batch set records', status: 500 });
        }
    }

    async batchGet(req, res) {
        try {
            const { collection } = req.params;
            const { keys } = req.body;
            if (!Array.isArray(keys)) {
                res.status(400).json({ error: 'Keys must be an array', status: 400 });
            } else {
                const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
                const data = await this.readJsonFile(collectionPath) || {};
                const results = [];
                const errors = [];
                for (const key of keys) {
                    if (data[key]) {
                        results.push(data[key]);
                    } else {
                        errors.push({ key, error: 'Record not found', status: 404 });
                    }
                }
                res.json({ results, errors, total: keys.length });
            }
        } catch (error) {
            res.status(500).json({ error: 'Failed to batch get records', status: 500 });
        }
    }

    async batchDelete(req, res) {
        try {
            const { collection } = req.params;
            const { keys } = req.body;
            if (!Array.isArray(keys)) {
                res.status(400).json({ error: 'Keys must be an array', status: 400 });
            } else {
                const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
                let data = await this.readJsonFile(collectionPath) || {};
                const results = [];
                const errors = [];
                for (const key of keys) {
                    if (data[key]) {
                        delete data[key];
                        results.push({ key, status: 'success' });
                    } else {
                        errors.push({ key, error: 'Record not found', status: 404 });
                    }
                }
                await this.writeJsonFile(collectionPath, data);
                res.json({ results, errors, total: keys.length });
            }
        } catch (error) {
            res.status(500).json({ error: 'Failed to batch delete records', status: 500 });
        }
    }

    async batchUpdate(req, res) {
        try {
            const { collection } = req.params;
            const { updates } = req.body;
            if (!Array.isArray(updates) || !updates.every(u => u.id && u.updates)) {
                res.status(400).json({ error: 'Updates must be an array of { id, updates } objects', status: 400 });
            } else {
                const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
                let data = await this.readJsonFile(collectionPath) || {};
                const results = [];
                const errors = [];
                for (const { id, updates } of updates) {
                    if (data[id]) {
                        const record = {
                            ...data[id],
                            ...updates,
                            id,
                            updatedAt: new Date().toISOString(),
                            createdAt: data[id].createdAt || new Date().toISOString()
                        };
                        data[id] = record;
                        results.push({ id, status: 'success', record });
                    } else {
                        errors.push({ id, error: 'Record not found', status: 404 });
                    }
                }
                await this.writeJsonFile(collectionPath, data);
                res.json({ results, errors, total: updates.length });
            }
        } catch (error) {
            res.status(500).json({ error: 'Failed to batch update records', status: 500 });
        }
    }

    async incrementField(req, res) {
        try {
            const { collection, id } = req.params;
            const { field, amount = 1 } = req.body;
            const collectionPath = path.join(this.projectsDir, req.projectId, `${collection}.json`);
            let data = await this.readJsonFile(collectionPath) || {};

            if (!data[id]) {
                res.status(404).json({ error: 'Record not found', status: 404 });
                return;
            }

            // Handle nested fields (field paths with dots)
            const fieldParts = field.split('.');
            let current = data[id];

            for (let i = 0; i < fieldParts.length - 1; i++) {
                const part = fieldParts[i];
                if (!current[part]) {
                    current[part] = {};
                }
                current = current[part];
            }

            const lastPart = fieldParts[fieldParts.length - 1];
            current[lastPart] = (current[lastPart] || 0) + amount;
            data[id].updatedAt = new Date().toISOString();

            await this.writeJsonFile(collectionPath, data);
            res.json(data[id]);
        } catch (error) {
            res.status(error.status || 500).json({
                error: error.message || 'Failed to increment field',
                status: error.status || 500
            });
        }
    }

    async updateProjectCollections(req, res) {
        try {
            const { projectId } = req.params;
            const { collections } = req.body;
            const data = await this.readManageDB();
            const project = data.projects.find(p => p.id === projectId);
            if (!project) {
                res.status(404).json({ error: 'Project not found', status: 404 });
            } else {
                if (collections && Array.isArray(collections)) {
                    const existingCollections = project.collections || [];
                    const newCollections = collections.filter(c =>
                        c.name && !existingCollections.find(ec => ec.name === c.name)
                    );
                    project.collections = [...existingCollections, ...newCollections];
                    project.updatedAt = new Date().toISOString();
                    await this.writeManageDB(data);
                }
                res.json({ success: true, collections: project.collections });
            }
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to update project collections', status: error.status || 500 });
        }
    }

    async getUserProjects(req, res) {
        try {
            const data = await this.readManageDB();
            const user = data.users.find(u => u.id === req.user.userId);
            if (!user) {
                res.status(404).json({ error: 'User not found', status: 404 });
            } else {
                const projects = data.projects.filter(p => p.ownerId === user.id || req.user.role === 'admin');
                res.json({ projects });
            }
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to get user projects', status: error.status || 500 });
        }
    }

    async createProject(req, res) {
        try {
            const { name, description } = req.body;
            if (!name) {
                res.status(400).json({ error: 'Project name required', status: 400 });
            } else {
                const projectId = uuidv4();
                const projectDir = path.join(this.projectsDir, projectId);
                await fs.mkdir(projectDir, { recursive: true });
                const project = {
                    id: projectId,
                    name,
                    description: description || '',
                    ownerId: req.user.userId,
                    collections: [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                const defaultToken = {
                    id: uuidv4(),
                    projectId,
                    name: 'Default Token',
                    token: crypto.randomBytes(32).toString('hex'),
                    permissions: 'full',
                    active: true,
                    createdAt: new Date().toISOString()
                };
                const data = await this.readManageDB();
                data.projects.push(project);
                data.tokens.push(defaultToken);
                await this.writeManageDB(data);
                res.status(201).json({
                    id: projectId,
                    ...project,
                    defaultToken: defaultToken.token
                });
            }
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to create project', status: error.status || 500 });
        }
    }

    async deleteProject(req, res) {
        try {
            const { projectId } = req.params;
            const projectDir = path.join(this.projectsDir, projectId);
            const data = await this.readManageDB();
            const project = data.projects.find(p => p.id === projectId);
            if (!project) {
                res.status(404).json({ error: 'Project not found', status: 404 });
            } else if (project.ownerId !== req.user.userId && req.user.role !== 'admin') {
                res.status(403).json({ error: 'Not authorized to delete this project', status: 403 });
            } else {
                data.projects = data.projects.filter(p => p.id !== projectId);
                data.tokens = data.tokens.filter(t => t.projectId !== projectId);
                await this.writeManageDB(data);
                await fs.rm(projectDir, { recursive: true, force: true });
                res.status(204).send();
            }
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to delete project', status: error.status || 500 });
        }
    }

    async getProjectTokens(req, res) {
        try {
            const { projectId } = req.params;
            const data = await this.readManageDB();
            const tokens = data.tokens.filter(t => t.projectId === projectId);
            const safeTokens = tokens.map(t => ({
                id: t.id,
                name: t.name,
                permissions: t.permissions,
                active: t.active,
                createdAt: t.createdAt,
                lastUsed: t.lastUsed,
                token: t.token
            }));
            res.json({ tokens: safeTokens });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get tokens', status: 500 });
        }
    }

    async createProjectToken(req, res) {
        try {
            const { projectId } = req.params;
            const { name, permissions = 'full' } = req.body;
            if (!['read', 'write', 'full'].includes(permissions)) {
                res.status(400).json({ error: 'Invalid permissions', status: 400 });
            } else {
                const data = await this.readManageDB();
                const newToken = {
                    id: uuidv4(),
                    projectId,
                    name: name || 'Unnamed Token',
                    token: crypto.randomBytes(32).toString('hex'),
                    permissions,
                    active: true,
                    createdAt: new Date().toISOString()
                };
                data.tokens.push(newToken);
                await this.writeManageDB(data);
                res.status(201).json({
                    id: newToken.id,
                    name: newToken.name,
                    token: newToken.token,
                    permissions: newToken.permissions,
                    active: newToken.active,
                    createdAt: newToken.createdAt
                });
            }
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to create project token', status: error.status || 500 });
        }
    }

    async deleteProjectToken(req, res) {
        try {
            const { projectId, tokenId } = req.params;
            const data = await this.readManageDB();
            data.tokens = data.tokens.filter(t => t.id !== tokenId || t.projectId !== projectId);
            await this.writeManageDB(data);
            res.status(204).send();
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to delete project token', status: error.status || 500 });
        }
    }

    async getAdminUsers(req, res) {
        try {
            const users = await this.getUsersData();
            const safeUsers = users.map(u => ({
                id: u.id,
                username: u.username,
                email: u.email,
                role: u.role,
                createdAt: u.createdAt,
                lastLogin: u.lastLogin
            }));
            res.json({ users: safeUsers });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get users', status: 500 });
        }
    }

    async deleteUser(req, res) {
        try {
            const { userId } = req.params;
            const users = await this.getUsersData();
            const userIndex = users.findIndex(u => u.id === userId);
            if (userIndex === -1) {
                res.status(404).json({ error: 'User not found', status: 404 });
            } else {
                const adminUsers = users.filter(u => u.role === 'admin');
                if (adminUsers.length === 1 && users[userIndex].role === 'admin') {
                    res.status(400).json({ error: 'Cannot delete the last admin user', status: 400 });
                } else {
                    users.splice(userIndex, 1);
                    await this.saveUsers(users);
                    res.status(204).send();
                }
            }
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to delete user', status: error.status || 500 });
        }
    }

    async updateUserRole(req, res) {
        try {
            const { userId } = req.params;
            const { role } = req.body;
            if (!['user', 'admin'].includes(role)) {
                res.status(400).json({ error: 'Invalid role', status: 400 });
            } else {
                const users = await this.getUsersData();
                const user = users.find(u => u.id === userId);
                if (!user) {
                    res.status(404).json({ error: 'User not found', status: 404 });
                } else {
                    const adminUsers = users.filter(u => u.role === 'admin');
                    if (adminUsers.length === 1 && user.role === 'admin' && role !== 'admin') {
                        res.status(400).json({ error: 'Cannot remove admin role from the last admin', status: 400 });
                    } else {
                        user.role = role;
                        await this.saveUsers(users);
                        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
                    }
                }
            }
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to update user role', status: error.status || 500 });
        }
    }

    async deleteProjectAdmin(req, res) {
        try {
            const { projectId } = req.params;
            const projectDir = path.join(this.projectsDir, projectId);
            const data = await this.readManageDB();
            data.projects = data.projects.filter(p => p.id !== projectId);
            data.tokens = data.tokens.filter(t => t.projectId !== projectId);
            await this.writeManageDB(data);
            await fs.rm(projectDir, { recursive: true, force: true });
            res.status(204).send();
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to delete project', status: error.status || 500 });
        }
    }

    async getAllProjects(req, res) {
        try {
            const data = await this.readManageDB();
            res.json({ projects: data.projects });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get projects', status: 500 });
        }
    }

    start() {
        this.app.listen(PORT, () => {
            console.log(`🚀 LiekoDB Server running on port ${PORT}`);
            console.log(`📊 Panel: ${HOST}:${PORT}/${PANEL_ROUTE}`);
            console.log(`🔑 Default admin: username=admin, password=admin123`);
            console.log(`📁 Storage directory: ${this.storageDir}`);
        });
    }
}

if (require.main === module) {
    new LiekoDBCore().start();
}

module.exports = LiekoDBCore;
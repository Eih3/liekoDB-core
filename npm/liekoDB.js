class EventEmitter {
    constructor() {
        this._events = {};
    }

    on(event, listener) {
        if (!this._events[event]) {
            this._events[event] = [];
        }
        this._events[event].push(listener);
        return this;
    }

    once(event, listener) {
        const onceWrapper = (...args) => {
            this.off(event, onceWrapper);
            listener.apply(this, args);
        };
        return this.on(event, onceWrapper);
    }

    off(event, listener) {
        if (!this._events[event]) return this;
        this._events[event] = this._events[event].filter(l => l !== listener);
        if (this._events[event].length === 0) {
            delete this._events[event];
        }
        return this;
    }

    emit(event, ...args) {
        if (!this._events[event]) return false;
        this._events[event].forEach(listener => {
            try {
                listener.apply(this, args);
            } catch (error) {
                console.error('Event listener error:', error);
            }
        });
        return true;
    }

    removeAllListeners(event) {
        if (event) {
            delete this._events[event];
        } else {
            this._events = {};
        }
        return this;
    }

    listenerCount(event) {
        return this._events[event] ? this._events[event].length : 0;
    }
}

class liekoDB extends EventEmitter {
    constructor(options = {}) {
        super();
        if (!options.token) {
            throw new Error('Project token is required');
        }
        this.databaseUrl = options.databaseUrl || 'http://localhost:6050';
        this.token = options.token;
        this.projectId = null;
        this.projectName = null;
        this.permissions = null;
        this.collections = null;
        this.timeout = options.timeout || 5000;
        this.retryAttempts = options.retryAttempts || 3;
        this.retryDelay = options.retryDelay || 1000;
        this.debug = options.debug === true;
        this.throwOnNotFound = options.throwOnNotFound === true;
        this._isReady = false;
        this._isConnecting = false;
        this._collectionCache = new Map();
        this._headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'liekoDB-Client/1.0.0',
            'Authorization': `Bearer ${this.token}`
        };

        if (options.autoConnect !== false) {
            this._initialize();
        }
    }

    async _initialize() {
        if (this._isConnecting || this._isReady) return;
        this._isConnecting = true;
        this.emit('connecting');
        try {
            this._log('Initializing database connection...');

            const tokenValidation = await this._request('GET', '/api/token/validate');
            this.projectId = tokenValidation.project.id;
            this.permissions = tokenValidation.permissions;
            this.collections = tokenValidation.collections;
            this.projectName = tokenValidation.project.name;

            const collectionsList = this.collections.length > 0
                ? this.collections.map(c => c.name).join(',')
                : 'none';
            this._log(`Token validated: project=${this.projectName} (${this.projectId}), permissions=${this.permissions}, collections=${collectionsList}`);

            if (this.permissions === 'read') {
                this._log('Warning: Using read-only token; write and delete operations will fail');
            } else if (this.permissions === 'write') {
                this._log('Using write token; read and write operations allowed');
            } else if (this.permissions === 'full') {
                this._log('Using full-access token; all operations allowed');
            }
            this.emit('token:validated', {
                projectId: this.projectId,
                permissions: this.permissions,
                collections: this.collections,
                projectName: this.projectName
            });

            const health = await this.health();
            let pingMessage = 'ping: N/A';
            try {
                const latency = await this.ping();
                pingMessage = `ping: ${this._formatDuration(latency.data)}ms`;
            } catch (error) {
                this._logError('Ping failed during initialization:', error.message);
                pingMessage = 'ping: failed';
            }
            this._log(`Database health: ${health.data.status}, ${pingMessage}`);

            this._isReady = true;
            this._isConnecting = false;
            this._log('Database connection established');
            this.emit('ready', this);
        } catch (error) {
            this._isConnecting = false;
            this._logError('Failed to initialize database connection:', error.message);
            this.emit('error', new Error(`Failed to connect to database: ${error.message}`));
            throw error;
        }
    }

    get isReady() {
        return this._isReady;
    }

    get isConnecting() {
        return this._isConnecting;
    }

    _log(...args) {
        if (this.debug) {
            console.log('[liekoDB]', ...args);
        }
    }

    _logError(...args) {
        if (this.debug) {
            console.error('[liekoDB ERROR]', ...args);
        }
    }

    _createErrorResponse(error, operation, context = {}) {
        const errorCode = this._getErrorCode(error, context);
        const errorMessage = this._getHumanFriendlyError(error, operation, context);

        return {
            success: false,
            error: {
                code: errorCode,
                message: errorMessage,
                status: error.status || 500,
                operation: operation,
                timestamp: new Date().toISOString(),
                ...(context.collection && { collection: context.collection }),
                ...(context.key && { key: context.key })
            },
            data: null
        };
    }

    _getErrorCode(error, context = {}) {
        if (error.response && error.response.code) {
            return error.response.code; // Use server-provided error code
        }
        if (error.status === 401) return 'NO_TOKEN_PROVIDED';
        if (error.status === 403) return 'FORBIDDEN';
        if (error.status === 404) return 'RECORD_NOT_FOUND';
        if (error.status === 409) return 'RECORD_EXISTS';
        if (error.status === 429) return 'RATE_LIMIT_EXCEEDED';
        if (error.status >= 500) return 'SERVER_ERROR';
        if (error.name === 'AbortError') return 'TIMEOUT';
        if (error.code === 'ECONNRESET') return 'CONNECTION_RESET';
        if (error.code === 'ETIMEDOUT') return 'CONNECTION_TIMEOUT';
        return 'UNKNOWN_ERROR';
    }

    _getHumanFriendlyError(error, operation, context = {}) {
        const { collection, key } = context;
        if (error.response && error.response.code) {
            return error.response.message || error.message || 'An error occurred';
        }
        switch (error.status) {
            case 401:
                return 'Authentication failed. Please check your project token';
            case 403:
                return `Insufficient permissions for ${operation} operation${collection ? ` on collection '${collection}'` : ''}`;
            case 404:
                if (operation === 'get' && key) return `Record '${key}' not found in collection '${collection}'`;
                if (operation === 'delete' && key) return `Record '${key}' does not exist in collection '${collection}'`;
                return `Collection '${collection}' not found`;
            case 409:
                return `Conflict: Record already exists in collection '${collection}'`;
            case 429:
                return 'Too many requests. Please slow down and try again later';
            case 500:
            case 502:
            case 503:
            case 504:
                return 'Server error. Please try again later';
            default:
                if (error.name === 'AbortError') return `Request timeout after ${this.timeout}ms`;
                if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return 'Connection error. Please check your network and try again';
                return error.message || 'An unexpected error occurred';
        }
    }

    _transformResponse(rawResponse, operation = 'get', options = {}) {
        let data;
        let meta = {};

        if (rawResponse && typeof rawResponse === 'object' && rawResponse.hasOwnProperty('success')) {
            return rawResponse;
        }

        if (operation === 'batchSet' || operation === 'batchGet' || operation === 'batchDelete' || operation === 'batchUpdate') {
            data = rawResponse.results || [];
            meta = {
                operation,
                total: rawResponse.total || 0,
                errors: rawResponse.errors || [],
                ...(options.collection && { collection: options.collection })
            };
        } else if (Array.isArray(rawResponse)) {
            data = rawResponse;
            meta.count = rawResponse.length;
        } else if (rawResponse && typeof rawResponse === 'object' && rawResponse.data) {
            data = Array.isArray(rawResponse.data) ? rawResponse.data : [rawResponse.data];
            if (rawResponse.totalCount !== undefined) meta.totalCount = rawResponse.totalCount;
            if (rawResponse.actualPage !== undefined) meta.page = rawResponse.actualPage;
            if (rawResponse.maxPage !== undefined) meta.totalPages = rawResponse.maxPage;
        } else {
            data = rawResponse;
        }

        meta.operation = operation;
        if (options.collection) meta.collection = options.collection;
        if (options.single) meta.single = true;

        return {
            success: true,
            data,
            ...(Object.keys(meta).length > 0 && { meta })
        };
    }

    async get(collectionName, key = null, options = {}) {
        try {
            if (key && typeof key === 'object' && !Array.isArray(key)) {
                options = key;
                key = null;
            }
            this.emit('operation:start', { type: 'get', collection: collectionName, key });

            if (options.filter && options.filter.$search) {
                // Handle $search filter by redirecting to /search endpoint
                const searchTerm = options.filter.$search;
                const fields = options.filter.fields || null;
                const params = new URLSearchParams({ term: searchTerm });
                if (fields) params.set('fields', fields.join(','));
                if (options.sort) params.set('sort', options.sort);
                if (options.limit) params.set('limit', options.limit);
                if (options.offset) params.set('offset', options.offset);
                const url = `/api/collections/${collectionName}/search?${params.toString()}`;
                this._log('Redirecting $search filter to search endpoint:', url);
                const result = await this._request('GET', url);
                const response = this._transformResponse(result, 'get', { collection: collectionName });
                this.emit('operation:success', { type: 'get', collection: collectionName, key, result: response });
                return response;
            }

            const queryParams = this._buildQueryParams(options);
            const url = key
                ? `/api/collections/${collectionName}/${key}${queryParams}`
                : `/api/collections/${collectionName}${queryParams}`;
            const result = await this._request('GET', url);
            const response = this._transformResponse(result, 'get', { collection: collectionName, single: !!key });
            this.emit('operation:success', { type: 'get', collection: collectionName, key, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'get', { collection: collectionName, key });
            this.emit('operation:error', { type: 'get', collection: collectionName, key, error: errorResponse });
            if (error.status === 404 && !this.throwOnNotFound) {
                return errorResponse;
            }
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'get',
                collection: collectionName,
                key
            });
        }
    }

    async set(collectionName, id, data) {
        try {
            this.emit('operation:start', { type: 'set', collection: collectionName, id });
            const payload = { ...data, id };
            this._log(`Upsert payload for ${collectionName}/${id}:`, JSON.stringify(payload, null, 2));
            try {
                const result = await this._request('PUT', `/api/collections/${collectionName}/${id}`, payload);
                const response = this._transformResponse(result, 'set', { collection: collectionName });
                this.emit('operation:success', { type: 'set', collection: collectionName, id, result: response });
                this.emit('record:updated', { collection: collectionName, id, data: payload });
                return response;
            } catch (error) {
                if (error.status === 404) {
                    const result = await this._request('POST', `/api/collections/${collectionName}`, payload);
                    const response = this._transformResponse(result, 'set', { collection: collectionName });
                    this.emit('operation:success', { type: 'set', collection: collectionName, id, result: response });
                    this.emit('record:created', { collection: collectionName, id, data: payload });
                    return response;
                }
                throw error;
            }
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'set', { collection: collectionName, key: id });
            this.emit('operation:error', { type: 'set', collection: collectionName, id, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'set',
                collection: collectionName,
                key: id
            });
        }
    }

    async update(collectionName, id, updates) {
        return this.set(collectionName, id, updates);
    }

    async delete(collectionName, key) {
        try {
            this.emit('operation:start', { type: 'delete', collection: collectionName, key });
            await this._request('DELETE', `/api/collections/${collectionName}/${key}`);
            const response = this._transformResponse(true, 'delete', { collection: collectionName });
            this.emit('operation:success', { type: 'delete', collection: collectionName, key, result: response });
            this.emit('record:deleted', { collection: collectionName, key });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'delete', { collection: collectionName, key });
            this.emit('operation:error', { type: 'delete', collection: collectionName, key, error: errorResponse });
            if (error.status === 404 && !this.throwOnNotFound) {
                return errorResponse;
            }
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'delete',
                collection: collectionName,
                key
            });
        }
    }

    async has(collectionName, key) {
        try {
            await this._request('GET', `/api/collections/${collectionName}/${key}`);
            return this._transformResponse(true, 'has', { collection: collectionName });
        } catch (error) {
            if (error.status === 404) {
                return this._transformResponse(false, 'has', { collection: collectionName });
            }
            const errorResponse = this._createErrorResponse(error, 'has', { collection: collectionName, key });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'has',
                collection: collectionName,
                key
            });
        }
    }

    async clear(collectionName) {
        try {
            this.emit('operation:start', { type: 'clear', collection: collectionName });
            await this._request('DELETE', `/api/collections/${collectionName}`);
            const response = this._transformResponse(true, 'clear', { collection: collectionName });
            this.emit('operation:success', { type: 'clear', collection: collectionName, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'clear', { collection: collectionName });
            this.emit('operation:error', { type: 'clear', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'clear',
                collection: collectionName
            });
        }
    }

    async find(collectionName, filter, options = {}) {
        try {
            this.emit('operation:start', { type: 'find', collection: collectionName });
            const queryParams = this._buildQueryParams({ ...options, filter });
            const url = `/api/collections/${collectionName}${queryParams}`;
            const result = await this._request('GET', url);
            const response = this._transformResponse(result, 'find', { collection: collectionName });
            this.emit('operation:success', { type: 'find', collection: collectionName, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'find', { collection: collectionName });
            this.emit('operation:error', { type: 'find', collection: collectionName, error: errorResponse });
            if (error.status === 404 && !this.throwOnNotFound) {
                return errorResponse;
            }
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'find',
                collection: collectionName
            });
        }
    }

    async findOne(collectionName, filter) {
        try {
            this.emit('operation:start', { type: 'findOne', collection: collectionName });
            const params = filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : '';
            const result = await this._request('GET', `/api/collections/${collectionName}/find-one${params}`);
            const response = this._transformResponse(result, 'findOne', { collection: collectionName, single: true });
            this.emit('operation:success', { type: 'findOne', collection: collectionName, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'findOne', { collection: collectionName });
            this.emit('operation:error', { type: 'findOne', collection: collectionName, error: errorResponse });
            if (error.status === 404 && !this.throwOnNotFound) {
                return errorResponse;
            }
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'findOne',
                collection: collectionName
            });
        }
    }

    async search(collectionName, term, fields, options = {}) {
        try {
            this.emit('operation:start', { type: 'search', collection: collectionName });
            const params = new URLSearchParams({ term });
            if (fields) params.set('fields', fields.join(','));
            if (options.sort) params.set('sort', options.sort);
            if (options.limit) params.set('limit', options.limit);
            if (options.offset) params.set('offset', options.offset);
            const url = `/api/collections/${collectionName}/search?${params.toString()}`;
            const result = await this._request('GET', url);
            const response = this._transformResponse(result, 'search', { collection: collectionName });
            this.emit('operation:success', { type: 'search', collection: collectionName, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'search', { collection: collectionName });
            this.emit('operation:error', { type: 'search', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'search',
                collection: collectionName
            });
        }
    }

    async count(collectionName, filter) {
        try {
            this.emit('operation:start', { type: 'count', collection: collectionName });
            const params = filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : '';
            const result = await this._request('GET', `/api/collections/${collectionName}/count${params}`);
            const response = this._transformResponse(result, 'count', { collection: collectionName });
            this.emit('operation:success', { type: 'count', collection: collectionName, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'count', { collection: collectionName });
            this.emit('operation:error', { type: 'count', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'count',
                collection: collectionName
            });
        }
    }

    async paginate(collectionName, page, perPage, options = {}) {
        try {
            this.emit('operation:start', { type: 'paginate', collection: collectionName });
            const offset = (page - 1) * perPage;
            const queryParams = this._buildQueryParams({ ...options, limit: perPage, offset });
            const url = `/api/collections/${collectionName}${queryParams}`;
            const result = await this._request('GET', url);
            const paginationData = {
                data: Array.isArray(result) ? result : (result.data || []),
                totalCount: result.totalCount || 0,
                actualPage: result.actualPage || page,
                maxPage: result.maxPage || 1,
                perPage,
                hasNextPage: (result.actualPage || page) < (result.maxPage || 1),
                hasPrevPage: (result.actualPage || page) > 1
            };
            const response = this._transformResponse(paginationData, 'paginate', { collection: collectionName });
            this.emit('operation:success', { type: 'paginate', collection: collectionName, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'paginate', { collection: collectionName });
            this.emit('operation:error', { type: 'paginate', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'paginate',
                collection: collectionName
            });
        }
    }

    async increment(collectionName, id, field, amount = 1) {
        try {
            this.emit('operation:start', { type: 'increment', collection: collectionName, id });
            const result = await this._request('POST', `/api/collections/${collectionName}/${id}/increment`, { field, value: amount });
            const response = this._transformResponse(result, 'increment', { collection: collectionName });
            this.emit('operation:success', { type: 'increment', collection: collectionName, id, result: response });
            this.emit('record:updated', { collection: collectionName, id, data: result });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'increment', { collection: collectionName, key: id });
            this.emit('operation:error', { type: 'increment', collection: collectionName, id, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'increment',
                collection: collectionName,
                key: id
            });
        }
    }

    async decrement(collectionName, id, field, amount = 1) {
        try {
            this.emit('operation:start', { type: 'decrement', collection: collectionName, id });
            const result = await this._request('POST', `/api/collections/${collectionName}/${id}/decrement`, { field, value: amount });
            const response = this._transformResponse(result, 'decrement', { collection: collectionName });
            this.emit('operation:success', { type: 'decrement', collection: collectionName, id, result: response });
            this.emit('record:updated', { collection: collectionName, id, data: result });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'decrement', { collection: collectionName, key: id });
            this.emit('operation:error', { type: 'decrement', collection: collectionName, id, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'decrement',
                collection: collectionName,
                key: id
            });
        }
    }

    async batchSet(collectionName, records) {
        try {
            this.emit('operation:start', { type: 'batchSet', collection: collectionName });
            const result = await this._request('POST', `/api/collections/${collectionName}/batch-set`, { records });
            const response = this._transformResponse(result, 'batchSet', { collection: collectionName });
            this.emit('operation:success', { type: 'batchSet', collection: collectionName, result: response });
            if (result.results) {
                result.results.forEach(r => {
                    if (r.status === 'success') {
                        this.emit('record:created', { collection: collectionName, id: r.id, data: r.record });
                    }
                });
            }
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'batchSet', { collection: collectionName });
            this.emit('operation:error', { type: 'batchSet', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'batchSet',
                collection: collectionName
            });
        }
    }

    async batchGet(collectionName, ids) {
        try {
            this.emit('operation:start', { type: 'batchGet', collection: collectionName });
            const result = await this._request('POST', `/api/collections/${collectionName}/batch-get`, { ids });
            const response = this._transformResponse(result, 'batchGet', { collection: collectionName });
            this.emit('operation:success', { type: 'batchGet', collection: collectionName, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'batchGet', { collection: collectionName });
            this.emit('operation:error', { type: 'batchGet', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'batchGet',
                collection: collectionName
            });
        }
    }

    async batchDelete(collectionName, ids) {
        try {
            this.emit('operation:start', { type: 'batchDelete', collection: collectionName });
            const result = await this._request('POST', `/api/collections/${collectionName}/batch-delete`, { ids });
            const response = this._transformResponse(result, 'batchDelete', { collection: collectionName });
            this.emit('operation:success', { type: 'batchDelete', collection: collectionName, result: response });
            if (result.results) {
                result.results.forEach(r => {
                    if (r.status === 'success') {
                        this.emit('record:deleted', { collection: collectionName, key: r.id });
                    }
                });
            }
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'batchDelete', { collection: collectionName });
            this.emit('operation:error', { type: 'batchDelete', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'batchDelete',
                collection: collectionName
            });
        }
    }

    async batchUpdate(collectionName, updates) {
        try {
            this.emit('operation:start', { type: 'batchUpdate', collection: collectionName });
            const result = await this._request('POST', `/api/collections/${collectionName}/batch-update`, { updates });
            const response = this._transformResponse(result, 'batchUpdate', { collection: collectionName });
            this.emit('operation:success', { type: 'batchUpdate', collection: collectionName, result: response });
            if (result.results) {
                result.results.forEach(r => {
                    if (r.status === 'success') {
                        this.emit('record:updated', { collection: collectionName, id: r.id, data: r.record });
                    }
                });
            }
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'batchUpdate', { collection: collectionName });
            this.emit('operation:error', { type: 'batchUpdate', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'batchUpdate',
                collection: collectionName
            });
        }
    }

    async keys(collectionName, options = {}) {
        try {
            this.emit('operation:start', { type: 'keys', collection: collectionName });
            const result = await this._request('GET', `/api/collections/${collectionName}/keys`);
            const response = this._transformResponse(result.keys, 'keys', { collection: collectionName });
            this.emit('operation:success', { type: 'keys', collection: collectionName, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'keys', { collection: collectionName });
            this.emit('operation:error', { type: 'keys', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'keys',
                collection: collectionName
            });
        }
    }

    async values(collectionName, options = {}) {
        return this.get(collectionName, null, options);
    }

    async entries(collectionName, options = {}) {
        try {
            this.emit('operation:start', { type: 'entries', collection: collectionName });
            const result = await this._request('GET', `/api/collections/${collectionName}/entries`);
            const response = this._transformResponse(result.entries, 'entries', { collection: collectionName });
            this.emit('operation:success', { type: 'entries', collection: collectionName, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'entries', { collection: collectionName });
            this.emit('operation:error', { type: 'entries', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'entries',
                collection: collectionName
            });
        }
    }

    async size(collectionName) {
        try {
            this.emit('operation:start', { type: 'size', collection: collectionName });
            const result = await this._request('GET', `/api/collections/${collectionName}/size`);
            const response = this._transformResponse(result.size, 'size', { collection: collectionName });
            this.emit('operation:success', { type: 'size', collection: collectionName, result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'size', { collection: collectionName });
            this.emit('operation:error', { type: 'size', collection: collectionName, error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'size',
                collection: collectionName
            });
        }
    }

    async health() {
        try {
            const result = await this._request('GET', '/api/health');
            const response = this._transformResponse(result, 'health');
            this.emit('health:check', { status: 'healthy', result: response });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'health');
            this.emit('health:check', { status: 'unhealthy', error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'health'
            });
        }
    }

    async ping() {
        try {
            const start = Date.now();
            await this._request('GET', '/api/ping');
            const latency = Date.now() - start;
            const response = this._transformResponse(latency, 'ping');
            this.emit('operation:success', { type: 'ping', latency });
            return response;
        } catch (error) {
            const errorResponse = this._createErrorResponse(error, 'ping');
            this.emit('operation:error', { type: 'ping', error: errorResponse });
            throw new DatabaseError(errorResponse.error.message, {
                code: errorResponse.error.code,
                status: errorResponse.error.status,
                operation: 'ping'
            });
        }
    }

    getConnectionInfo() {
        const info = {
            URI: this.databaseUrl,
            token: this.token,
            projectId: this.projectId,
            permissions: this.permissions,
            collections: this.collections,
            timeout: this.timeout,
            retryAttempts: this.retryAttempts,
            retryDelay: this.retryDelay
        };
        return this._transformResponse(info, 'connectionInfo');
    }

    _buildQueryParams(options) {
        const params = new URLSearchParams();
        if (options.limit !== undefined) params.set('limit', options.limit);
        if (options.offset) params.set('offset', options.offset);
        if (options.sort) params.set('sort', options.sort);
        if (options.filter && !options.filter.$search) {
            params.set('filter', JSON.stringify(options.filter));
        }
        if (options.fields) params.set('fields', options.fields.join(','));
        const queryString = params.toString() ? '?' + params.toString() : '';
        this._log('Query Params:', queryString);
        return queryString;
    }

    _formatSize(bytes) {
        if (typeof bytes !== 'number' || bytes === 0) return '0 bytes';
        if (bytes < 1000) return `${bytes} bytes`;
        if (bytes < 1000000) return `${(bytes / 1000).toFixed(1)} KB`;
        return `${(bytes / 1000000).toFixed(1)} MB`;
    }

    _formatDuration(ms) {
        if (typeof ms !== 'number' || ms < 0) return '0ms';
        if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
        return `${ms.toFixed(2)}ms`;
    }

    async _request(method, endpoint, data = null, attempt = 1) {
        const url = `${this.databaseUrl}${endpoint}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        const options = {
            method,
            headers: this._headers,
            signal: controller.signal
        };
        let requestSize = 0;
        if (data && ['POST', 'PUT', 'PATCH'].includes(method)) {
            options.body = JSON.stringify(data);
            requestSize = this._getByteLength(options.body);
        }
        const startTime = performance.now();
        try {
            const response = await fetch(url, options);
            const duration = performance.now() - startTime;
            clearTimeout(timeoutId);

            let responseSize = 0;
            let responseData;
            if (response.status === 204 || method === 'HEAD') {
                responseData = response.ok;
                responseSize = 0;
            } else {
                const contentType = response.headers.get('content-type');
                if (contentType?.includes('application/json')) {
                    responseData = await response.json();
                    responseSize = this._getByteLength(JSON.stringify(responseData));
                } else {
                    responseData = await response.text();
                    responseSize = this._getByteLength(responseData);
                }
            }

            const requestLog = {
                method,
                endpoint,
                status: response.status,
                duration,
                durationHuman: this._formatDuration(duration),
                requestSize,
                responseSize,
                requestSizeHuman: this._formatSize(requestSize),
                responseSizeHuman: this._formatSize(responseSize),
                attempt
            };
            if (method !== 'HEAD') {
                this._log(
                    `Request: ${method} ${endpoint} | Status: ${response.status} | ` +
                    `Duration: ${requestLog.durationHuman} | ` +
                    `Request Size: ${requestLog.requestSizeHuman} | ` +
                    `Response Size: ${requestLog.responseSizeHuman}`
                );
            }

            this.emit('request:completed', requestLog);

            if (!response.ok) {
                let errorMsg = `HTTP ${response.status}: ${response.statusText}`;
                try {
                    if (responseData && typeof responseData === 'object') {
                        if (responseData.errors) {
                            errorMsg = responseData.errors.map(e => `${e.id || 'unknown'}: ${e.error}`).join('; ');
                        } else if (responseData.error) {
                            errorMsg = responseData.error;
                        }
                    }
                } catch (_) {}
                const error = new Error(errorMsg);
                error.status = response.status;
                error.response = responseData;
                throw error;
            }

            return responseData;
        } catch (error) {
            clearTimeout(timeoutId);
            const duration = performance.now() - startTime;
            const errorLog = {
                method,
                endpoint,
                status: error.status || 'N/A',
                duration,
                durationHuman: this._formatDuration(duration),
                requestSize,
                responseSize: 0,
                requestSizeHuman: this._formatSize(requestSize),
                responseSizeHuman: this._formatSize(0),
                attempt,
                error: error.message
            };
            this._logError(
                `Request Failed: ${method} ${endpoint} | Status: ${errorLog.status} | ` +
                `Duration: ${errorLog.durationHuman} | ` +
                `Request Size: ${errorLog.requestSizeHuman} | ` +
                `Error: ${error.message}`
            );
            this.emit('request:failed', errorLog);

            if (this._shouldRetry(error) && attempt <= this.retryAttempts) {
                this._log(`Request failed, retrying in ${this.retryDelay * attempt}ms... (attempt ${attempt}/${this.retryAttempts})`);
                await this._delay(this.retryDelay * attempt);
                return this._request(method, endpoint, data, attempt + 1);
            }
            throw error;
        }
    }

    _getByteLength(str) {
        if (typeof str !== 'string') return 0;
        if (typeof Buffer !== 'undefined') {
            return Buffer.byteLength(str, 'utf8');
        }
        if (typeof TextEncoder !== 'undefined') {
            return new TextEncoder().encode(str).length;
        }
        return new Blob([str]).size;
    }

    _shouldRetry(error) {
        return error.name === 'AbortError' ||
            error.code === 'ECONNRESET' ||
            error.code === 'ETIMEDOUT' ||
            (error.status >= 500 && error.status < 600);
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

class DatabaseError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DatabaseError';
        this.code = details.code;
        this.status = details.status;
        this.operation = details.operation;
        this.collection = details.collection;
        this.key = details.key;
        this.timestamp = new Date().toISOString();
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            status: this.status,
            operation: this.operation,
            collection: this.collection,
            key: this.key,
            timestamp: this.timestamp
        };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = liekoDB;
    module.exports.DatabaseError = DatabaseError;
} else {
    window.liekoDB = liekoDB;
    window.DatabaseError = DatabaseError;
}
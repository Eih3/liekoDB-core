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
        this._isReady = false;
        this._isConnecting = false;
        this._collectionCache = new Map();
        this._headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'liekoDB-Client/1.0.0',
            'Authorization': `Bearer ${this.token}`
        };
        this._objectBasedPatterns = new Set(['users', 'profiles', 'accounts', 'settings']);
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
                pingMessage = `ping: ${this._formatDuration(latency)}`;
            } catch (error) {
                this._logError('Ping failed during initialization:', error.message);
                pingMessage = 'ping: failed';
            }
            this._log(`Database health: ${health.status}, ${pingMessage}`);
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

    _handleError(error, context = '') {
        const enhancedError = new Error(`${context}: ${error.message}`);
        enhancedError.originalError = error;
        enhancedError.context = context;
        enhancedError.status = error.status;
        this._logError(enhancedError.message);
        this.emit('error', enhancedError);
        return enhancedError;
    }

    _transformResponse(data, options = {}) {
        if (options.returnType === 'array') return Array.isArray(data) ? data : data.data || [];
        if (options.returnType === 'map') return new Map(Object.entries(data.data || data));
        if (Array.isArray(data) || (data.data && Array.isArray(data.data))) {
            const records = Array.isArray(data) ? data : data.data;
            return (this._objectBasedPatterns.has(options.collectionName) || options.returnType === 'object')
                ? records.reduce((obj, record) => {
                    if (record.id) obj[record.id] = record;
                    return obj;
                }, {})
                : records;
        }
        return data;
    }

    async get(collectionName, key = null, options = {}) {
        try {
            this.emit('operation:start', { type: 'get', collection: collectionName, key });
            if (key) {
                const result = await this._request('GET', `/api/collections/${collectionName}/${key}`);
                this.emit('operation:success', { type: 'get', collection: collectionName, key, result });
                return result;
            }
            const queryParams = this._buildQueryParams(options);
            const url = `/api/collections/${collectionName}${queryParams}`;
            const response = await this._request('GET', url);
            const transformed = this._transformResponse(response, { ...options, collectionName });
            this.emit('operation:success', { type: 'get', collection: collectionName, result: transformed });
            return transformed;
        } catch (error) {
            this.emit('operation:error', { type: 'get', collection: collectionName, key, error });
            throw this._handleError(error, `Failed to get from ${collectionName}`);
        }
    }

    async set(collectionName, id, data) {
        try {
            this.emit('operation:start', { type: 'set', collection: collectionName, id });
            const payload = { ...data, id };
            this._log(`Upsert payload for ${collectionName}/${id}:`, JSON.stringify(payload, null, 2));
            try {
                const result = await this._request('PUT', `/api/collections/${collectionName}/${id}`, payload);
                this.emit('operation:success', { type: 'set', collection: collectionName, id, result });
                this.emit('record:updated', { collection: collectionName, id, data: payload });
                return result;
            } catch (error) {
                if (error.status === 404) {
                    const result = await this._request('POST', `/api/collections/${collectionName}`, payload);
                    this.emit('operation:success', { type: 'set', collection: collectionName, id, result });
                    this.emit('record:created', { collection: collectionName, id, data: payload });
                    return result;
                }
                throw error;
            }
        } catch (error) {
            this.emit('operation:error', { type: 'set', collection: collectionName, id, error });
            throw this._handleError(error, `Failed to set record in ${collectionName}`);
        }
    }

    async update(collectionName, id, updates) {
        return this.set(collectionName, id, updates);
    }

    async delete(collectionName, key) {
        try {
            this.emit('operation:start', { type: 'delete', collection: collectionName, key });
            await this._request('DELETE', `/api/collections/${collectionName}/${key}`);
            this.emit('operation:success', { type: 'delete', collection: collectionName, key, result: true });
            this.emit('record:deleted', { collection: collectionName, key });
            return true;
        } catch (error) {
            if (error.status === 404) {
                this.emit('operation:success', { type: 'delete', collection: collectionName, key, result: false });
                return false;
            }
            this.emit('operation:error', { type: 'delete', collection: collectionName, key, error });
            throw this._handleError(error, `Failed to delete from ${collectionName}`);
        }
    }

    async has(collectionName, key) {
        try {
            await this._request('GET', `/api/collections/${collectionName}/${key}`);
            return true;
        } catch (error) {
            if (error.status === 404) return false;
            throw this._handleError(error, `Failed to check existence in ${collectionName}`);
        }
    }

    async clear(collectionName) {
        try {
            this.emit('operation:start', { type: 'clear', collection: collectionName });
            await this._request('DELETE', `/api/collections/${collectionName}`);
            this.emit('operation:success', { type: 'clear', collection: collectionName });
            return true;
        } catch (error) {
            this.emit('operation:error', { type: 'clear', collection: collectionName, error });
            throw this._handleError(error, `Failed to clear ${collectionName}`);
        }
    }

    async find(collectionName, filter, options = {}) {
        try {
            this.emit('operation:start', { type: 'find', collection: collectionName });
            const queryParams = this._buildQueryParams({ ...options, filter });
            const url = `/api/collections/${collectionName}${queryParams}`;
            const response = await this._request('GET', url);
            const transformed = this._transformResponse(response, { ...options, collectionName });
            this.emit('operation:success', { type: 'find', collection: collectionName, result: transformed });
            return transformed;
        } catch (error) {
            this.emit('operation:error', { type: 'find', collection: collectionName, error });
            throw this._handleError(error, `Failed to find in ${collectionName}`);
        }
    }

    async findOne(collectionName, filter) {
        try {
            this.emit('operation:start', { type: 'findOne', collection: collectionName });
            const params = filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : '';
            const response = await this._request('GET', `/api/collections/${collectionName}/find-one${params}`);
            this.emit('operation:success', { type: 'findOne', collection: collectionName, result: response });
            return response;
        } catch (error) {
            this.emit('operation:error', { type: 'findOne', collection: collectionName, error });
            throw this._handleError(error, `Failed to find one in ${collectionName}`);
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
            const response = await this._request('GET', url);
            const transformed = this._transformResponse(response, { ...options, collectionName });
            this.emit('operation:success', { type: 'search', collection: collectionName, result: transformed });
            return transformed;
        } catch (error) {
            this.emit('operation:error', { type: 'search', collection: collectionName, error });
            throw this._handleError(error, `Failed to search in ${collectionName}`);
        }
    }

    async count(collectionName, filter) {
        try {
            this.emit('operation:start', { type: 'count', collection: collectionName });
            const params = filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : '';
            const response = await this._request('GET', `/api/collections/${collectionName}/count${params}`);
            this.emit('operation:success', { type: 'count', collection: collectionName, result: response.count });
            return response.count;
        } catch (error) {
            this.emit('operation:error', { type: 'count', collection: collectionName, error });
            throw this._handleError(error, `Failed to count in ${collectionName}`);
        }
    }

    async paginate(collectionName, page, perPage, options = {}) {
        try {
            this.emit('operation:start', { type: 'paginate', collection: collectionName });
            const offset = (page - 1) * perPage;
            const queryParams = this._buildQueryParams({ ...options, limit: perPage, offset });
            const url = `/api/collections/${collectionName}${queryParams}`;
            const response = await this._request('GET', url);
            const transformed = {
                data: this._transformResponse(response, { ...options, collectionName }),
                totalCount: response.totalCount || 0
            };
            this.emit('operation:success', { type: 'paginate', collection: collectionName, result: transformed });
            return transformed;
        } catch (error) {
            this.emit('operation:error', { type: 'paginate', collection: collectionName, error });
            throw this._handleError(error, `Failed to paginate ${collectionName}`);
        }
    }

    async increment(collectionName, id, field, amount = 1) {
        try {
            this.emit('operation:start', { type: 'increment', collection: collectionName, id });
            const result = await this._request('POST', `/api/collections/${collectionName}/${id}/increment`, { field, amount });
            this.emit('operation:success', { type: 'increment', collection: collectionName, id, result });
            this.emit('record:updated', { collection: collectionName, id, data: result });
            return result;
        } catch (error) {
            this.emit('operation:error', { type: 'increment', collection: collectionName, id, error });
            throw this._handleError(error, `Failed to increment in ${collectionName}`);
        }
    }

    async decrement(collectionName, id, field, amount = 1) {
        try {
            this.emit('operation:start', { type: 'decrement', collection: collectionName, id });
            const result = await this._request('POST', `/api/collections/${collectionName}/${id}/decrement`, { field, amount });
            this.emit('operation:success', { type: 'decrement', collection: collectionName, id, result });
            this.emit('record:updated', { collection: collectionName, id, data: result });
            return result;
        } catch (error) {
            this.emit('operation:error', { type: 'decrement', collection: collectionName, id, error });
            throw this._handleError(error, `Failed to decrement in ${collectionName}`);
        }
    }

    async batchSet(collectionName, records, concurrency = 5) {
        try {
            this.emit('operation:start', { type: 'batchSet', collection: collectionName });
            const result = await this._request('POST', `/api/collections/${collectionName}/batch-set`, { records });
            this.emit('operation:success', { type: 'batchSet', collection: collectionName, result });
            result.results.forEach(r => {
                if (r.status === 'success') {
                    this.emit('record:created', { collection: collectionName, id: r.id, data: r.record });
                }
            });
            return result;
        } catch (error) {
            this.emit('operation:error', { type: 'batchSet', collection: collectionName, error });
            throw this._handleError(error, `Failed to batch set in ${collectionName}`);
        }
    }

    async batchGet(collectionName, keys, concurrency = 5) {
        try {
            this.emit('operation:start', { type: 'batchGet', collection: collectionName });
            const result = await this._request('POST', `/api/collections/${collectionName}/batch-get`, { keys });
            this.emit('operation:success', { type: 'batchGet', collection: collectionName, result });
            return result;
        } catch (error) {
            this.emit('operation:error', { type: 'batchGet', collection: collectionName, error });
            throw this._handleError(error, `Failed to batch get from ${collectionName}`);
        }
    }

    async batchDelete(collectionName, keys, concurrency = 5) {
        try {
            this.emit('operation:start', { type: 'batchDelete', collection: collectionName });
            const result = await this._request('POST', `/api/collections/${collectionName}/batch-delete`, { keys });
            this.emit('operation:success', { type: 'batchDelete', collection: collectionName, result });
            result.results.forEach(r => {
                if (r.status === 'success') {
                    this.emit('record:deleted', { collection: collectionName, key: r.key });
                }
            });
            return result;
        } catch (error) {
            this.emit('operation:error', { type: 'batchDelete', collection: collectionName, error });
            throw this._handleError(error, `Failed to batch delete from ${collectionName}`);
        }
    }

    async batchUpdate(collectionName, updates, concurrency = 5) {
        try {
            this.emit('operation:start', { type: 'batchUpdate', collection: collectionName });
            const result = await this._request('POST', `/api/collections/${collectionName}/batch-update`, { updates });
            this.emit('operation:success', { type: 'batchUpdate', collection: collectionName, result });
            result.results.forEach(r => {
                if (r.status === 'success') {
                    this.emit('record:updated', { collection: collectionName, id: r.id, data: r.record });
                }
            });
            return result;
        } catch (error) {
            this.emit('operation:error', { type: 'batchUpdate', collection: collectionName, error });
            throw this._handleError(error, `Failed to batch update in ${collectionName}`);
        }
    }

    async keys(collectionName, options = {}) {
        try {
            this.emit('operation:start', { type: 'keys', collection: collectionName });
            const response = await this._request('GET', `/api/collections/${collectionName}/keys`);
            this.emit('operation:success', { type: 'keys', collection: collectionName, result: response.keys });
            return response.keys;
        } catch (error) {
            this.emit('operation:error', { type: 'keys', collection: collectionName, error });
            throw this._handleError(error, `Failed to get keys from ${collectionName}`);
        }
    }

    async values(collectionName, options = {}) {
        try {
            this.emit('operation:start', { type: 'values', collection: collectionName });
            const queryParams = this._buildQueryParams(options);
            const url = `/api/collections/${collectionName}${queryParams}`;
            const response = await this._request('GET', url);
            const transformed = this._transformResponse(response, { ...options, collectionName, returnType: 'array' });
            this.emit('operation:success', { type: 'values', collection: collectionName, result: transformed });
            return transformed;
        } catch (error) {
            this.emit('operation:error', { type: 'values', collection: collectionName, error });
            throw this._handleError(error, `Failed to get values from ${collectionName}`);
        }
    }

    async entries(collectionName, options = {}) {
        try {
            this.emit('operation:start', { type: 'entries', collection: collectionName });
            const response = await this._request('GET', `/api/collections/${collectionName}/entries`);
            this.emit('operation:success', { type: 'entries', collection: collectionName, result: response.entries });
            return response.entries;
        } catch (error) {
            this.emit('operation:error', { type: 'entries', collection: collectionName, error });
            throw this._handleError(error, `Failed to get entries from ${collectionName}`);
        }
    }

    async size(collectionName) {
        try {
            this.emit('operation:start', { type: 'size', collection: collectionName });
            const response = await this._request('GET', `/api/collections/${collectionName}/size`);
            this.emit('operation:success', { type: 'size', collection: collectionName, result: response.size });
            return response.size;
        } catch (error) {
            this.emit('operation:error', { type: 'size', collection: collectionName, error });
            throw this._handleError(error, `Failed to get size of ${collectionName}`);
        }
    }

    async health() {
        try {
            const result = await this._request('GET', '/api/health');
            this.emit('health:check', { status: 'healthy', result });
            return result;
        } catch (error) {
            this.emit('health:check', { status: 'unhealthy', error });
            throw error;
        }
    }

    async ping() {
        try {
            const start = Date.now();
            await this._request('GET', '/api/ping');
            const latency = Date.now() - start;
            this.emit('operation:success', { type: 'ping', latency });
            return latency;
        } catch (error) {
            this.emit('operation:error', { type: 'ping', error });
            throw this._handleError(error, 'Failed to ping server');
        }
    }

    getConnectionInfo() {
        return {
            URI: this.databaseUrl,
            token: this.token,
            projectId: this.projectId,
            permissions: this.permissions,
            collections: this.collections,
            timeout: this.timeout,
            retryAttempts: this.retryAttempts,
            retryDelay: this.retryDelay
        };
    }

    _buildQueryParams(options) {
        const params = new URLSearchParams();
        if (options.limit !== undefined) params.set('limit', options.limit);
        if (options.offset) params.set('offset', options.offset);
        if (options.sort) params.set('sort', options.sort);
        if (options.filter) params.set('filter', encodeURIComponent(JSON.stringify(options.filter)));
        return params.toString() ? '?' + params.toString() : '';
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
                const error = new Error(responseData.error || `HTTP ${response.status}: ${response.statusText}`);
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

            if (error.status === 401) {
                throw new Error('Invalid project token');
            }
            if (error.status === 403) {
                throw new Error(`Insufficient permissions for ${method} operation on ${endpoint}`);
            }
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = liekoDB;
} else {
    window.liekoDB = liekoDB;
}
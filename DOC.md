# liekoDB Documentation

## Overview
`liekoDB` is a JavaScript client library for interacting with a RESTful database API. Built on top of an `EventEmitter`, it provides a robust interface for performing CRUD operations, searching, batch processing, pagination, and health checks. The library includes features like request retries, timeout handling, and detailed error reporting, making it suitable for both simple and complex database interactions.

## Install your own LiekoDB Server
[Github: liekoDB-core](https://github.com/Eih3/liekoDB-core)

## Constructor
```javascript
new liekoDB(options)
```
Initializes a new `liekoDB` client instance.

### Parameters
- `options` (Object): Configuration options.
  - `token` (String, **required**): Authentication token for the project.
  - `databaseUrl` (String, optional): Base URL of the database API. Defaults to `'http://localhost:6050'`.
  - `timeout` (Number, optional): Request timeout in milliseconds. Defaults to `5000`.
  - `retryAttempts` (Number, optional): Number of retry attempts for failed requests. Defaults to `3`.
  - `retryDelay` (Number, optional): Base delay between retries in milliseconds. Defaults to `1000`.
  - `debug` (Boolean, optional): Enables debug logging. Defaults to `false`.
  - `throwOnNotFound` (Boolean, optional): Throws errors on 404 responses if `true`. Defaults to `false`.
  - `autoConnect` (Boolean, optional): Automatically initializes the connection if `true`. Defaults to `true`.

### Returns
- `liekoDB`: The client instance.

### Events Emitted
- `connecting`: Fired when connection starts.
- `token:validated`: Fired after token validation with `{ projectId, permissions, collections, projectName }`.
- `ready`: Fired when the client is ready with the `liekoDB` instance.
- `error`: Fired on initialization errors with an `Error` object.

### Examples
#### Simple Example
Initialize a client with minimal configuration.
```javascript
const liekoDB = require('liekodb');
const db = new liekoDB({ token: 'your-project-token' });
```

#### Complex Example
Initialize with full configuration and event listeners.
```javascript
const liekoDB = require('liekodb');
const db = new liekoDB({
  token: 'your-project-token',
  databaseUrl: 'https://api.example.com',
  timeout: 10000,
  retryAttempts: 5,
  retryDelay: 2000,
  debug: true,
  throwOnNotFound: true
});

db.on('connecting', () => console.log('Connecting to database...'));
db.on('ready', () => console.log('Database ready!'));
db.on('error', (err) => console.error('Initialization error:', err.message));
```

## Properties
- `isReady` (Boolean, read-only): Indicates if the client is initialized.
- `isConnecting` (Boolean, read-only): Indicates if the client is connecting.
- `projectId` (String): Project ID from the token.
- `projectName` (String): Project name from the token.
- `permissions` (String): Permission level (`read`, `write`, `full`).
- `collections` (Array): Available collections.

## Methods

### 1. `get(collectionName, key, options)`
Retrieves a single record or multiple records from a collection.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `key` (String, optional): The record ID. If omitted, retrieves multiple records.
- `options` (Object, optional):
  - `filter` (Object): Filter criteria (e.g., `{ age: { $gt: 18 } }`).
  - `sort` (String): Sort field (e.g., `name:asc`).
  - `limit` (Number): Maximum records to return.
  - `offset` (Number): Records to skip.
  - `fields` (Array): Fields to include.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Array or Object): Retrieved record(s).
  - `meta` (Object, optional): Metadata like `count`, `operation`, `collection`, `page`, `totalPages`.

#### Events Emitted
- `operation:start`: `{ type: 'get', collection, key }`
- `operation:success`: `{ type: 'get', collection, key, result }`
- `operation:error`: `{ type: 'get', collection, key, error }`

#### Examples
##### Simple Example: Get a Single Record
```javascript
const result = await db.get('users', 'user123');
console.log(result.data); // { id: 'user123', name: 'John', age: 30 }
```

##### Complex Example: Get Filtered Records
```javascript
const result = await db.get('users', {
  filter: { age: { $gt: 18, $lte: 30 }, status: 'active' },
  sort: 'name:asc',
  limit: 10,
  offset: 20,
  fields: ['name', 'age']
});
console.log(result.data); // [{ name: 'Alice', age: 20 }, { name: 'Bob', age: 25 }, ...]
console.log(result.meta); // { operation: 'get', collection: 'users', count: 10 }
```

##### Example with Search Filter
```javascript
const result = await db.get('products', {
  filter: { $search: 'laptop', fields: ['name', 'description'] },
  limit: 5
});
console.log(result.data); // [{ id: 'prod1', name: 'Laptop Pro', ... }, ...]
```

##### Error Handling Example
```javascript
try {
  const result = await db.get('users', 'nonexistent', { throwOnNotFound: true });
} catch (error) {
  console.error(error.toJSON());
  // { name: 'DatabaseError', message: "Record 'nonexistent' not found in collection 'users'", ... }
}
```

---

### 2. `set(collectionName, id, data)`
Creates or updates a record (upsert).

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `id` (String, **required**): The record ID.
- `data` (Object, **required**): The data to set.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Object): Created or updated record.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'set', collection, id }`
- `operation:success`: `{ type: 'set', collection, id, result }`
- `operation:error`: `{ type: 'set', collection, id, error }`
- `record:created`: `{ collection, id, data }` (on create)
- `record:updated`: `{ collection, id, data }` (on update)

#### Examples
##### Simple Example: Create a Record
```javascript
const result = await db.set('users', 'user123', { name: 'John', age: 30 });
console.log(result.data); // { id: 'user123', name: 'John', age: 30 }
```

##### Complex Example: Update a Record
```javascript
const result = await db.set('users', 'user123', {
  name: 'John Doe',
  age: 31,
  address: { city: 'New York', zip: '10001' },
  tags: ['developer', 'active']
});
console.log(result.data); // Updated record with nested data
```

##### Example with Event Listener
```javascript
db.on('record:created', ({ collection, id, data }) => {
  console.log(`Created ${id} in ${collection}:`, data);
});
await db.set('products', 'prod1', { name: 'Laptop', price: 999.99 });
```

##### Error Handling Example
```javascript
try {
  await db.set('users', 'user123', { name: 'John' }); // Assuming insufficient permissions
} catch (error) {
  console.error(error.toJSON());
  // { name: 'DatabaseError', message: 'Insufficient permissions for set operation', ... }
}
```

---

### 3. `update(collectionName, id, updates)`
Alias for `set`. Updates a record.

#### Parameters
- Same as `set`.

#### Returns
- Same as `set`.

#### Events Emitted
- Same as `set`.

#### Examples
##### Simple Example: Update a Field
```javascript
const result = await db.update('users', 'user123', { age: 31 });
console.log(result.data); // { id: 'user123', name: 'John', age: 31 }
```

##### Complex Example: Partial Update
```javascript
const result = await db.update('users', 'user123', {
  address: { city: 'Boston' },
  tags: ['developer', 'senior']
});
console.log(result.data); // Updated record with partial changes
```

##### Example with Nested Data
```javascript
const result = await db.update('users', 'user123', {
  preferences: { notifications: { email: true, sms: false } }
});
console.log(result.data); // Updated record with nested preferences
```

---

### 4. `delete(collectionName, key)`
Deletes a single record.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `key` (String, **required**): The record ID.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Boolean): `true` if deleted.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'delete', collection, key }`
- `operation:success`: `{ type: 'delete', collection, key, result }`
- `operation:error`: `{ type: 'delete', collection, key, error }`
- `record:deleted`: `{ collection, key }`

#### Examples
##### Simple Example: Delete a Record
```javascript
const result = await db.delete('users', 'user123');
console.log(result.data); // true
```

##### Example with Event Listener
```javascript
db.on('record:deleted', ({ collection, key }) => {
  console.log(`Deleted ${key} from ${collection}`);
});
await db.delete('products', 'prod1');
```

##### Error Handling Example: Non-existent Record
```javascript
try {
  await db.delete('users', 'nonexistent', { throwOnNotFound: true });
} catch (error) {
  console.error(error.toJSON());
  // { name: 'DatabaseError', message: "Record 'nonexistent' does not exist in collection 'users'", ... }
}
```

---

### 5. `has(collectionName, key)`
Checks if a record exists.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `key` (String, **required**): The record ID.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Boolean): `true` if the record exists, `false` otherwise.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'has', collection, key }`
- `operation:success`: `{ type: 'has', collection, key, result }`
- `operation:error`: `{ type: 'has', collection, key, error }`

#### Examples
##### Simple Example: Check Existence
```javascript
const result = await db.has('users', 'user123');
console.log(result.data); // true or false
```

##### Complex Example: Conditional Logic
```javascript
const exists = await db.has('users', 'user123');
if (exists.data) {
  console.log('User exists, updating...');
  await db.update('users', 'user123', { lastLogin: new Date() });
} else {
  console.log('User does not exist, creating...');
  await db.set('users', 'user123', { name: 'John', lastLogin: new Date() });
}
```

---

### 6. `clear(collectionName)`
Deletes all records in a collection.

#### Parameters
- `collectionName` (String, **required**): The collection name.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Boolean): `true` if cleared.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'clear', collection }`
- `operation:success`: `{ type: 'clear', collection, result }`
- `operation:error`: `{ type: 'clear', collection, error }`

#### Examples
##### Simple Example: Clear Collection
```javascript
const result = await db.clear('users');
console.log(result.data); // true
```

##### Example with Confirmation
```javascript
const count = await db.count('users');
if (count.data > 0) {
  console.log(`Clearing ${count.data} records...`);
  await db.clear('users');
  console.log('Collection cleared');
}
```

---

### 7. `find(collectionName, filter, options)`
Finds records based on a filter.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `filter` (Object, **required**): Filter criteria.
- `options` (Object, optional): Same as `get` options.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Array): Matching records.
  - `meta` (Object, optional): Metadata like `operation`, `collection`, `count`.

#### Events Emitted
- `operation:start`: `{ type: 'find', collection }`
- `operation:success`: `{ type: 'find', collection, result }`
- `operation:error`: `{ type: 'find', collection, error }`

#### Examples
##### Simple Example: Basic Filter
```javascript
const result = await db.find('users', { status: 'active' });
console.log(result.data); // [{ id: 'user123', status: 'active', ... }, ...]
```

##### Complex Example: Advanced Filter
```javascript
const result = await db.find('products', {
  price: { $gte: 100, $lte: 500 },
  category: 'electronics'
}, {
  sort: 'price:asc',
  limit: 10,
  fields: ['name', 'price']
});
console.log(result.data); // [{ name: 'Mouse', price: 150 }, ...]
```

##### Example with Nested Filter
```javascript
const result = await db.find('users', {
  'address.city': 'New York',
  age: { $gte: 21 }
});
console.log(result.data); // Users in New York, age 21+
```

---

### 8. `findOne(collectionName, filter)`
Finds the first record matching a filter.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `filter` (Object, **required**): Filter criteria.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Object): First matching record or `null`.
  - `meta` (Object, optional): Metadata like `operation`, `collection`, `single: true`.

#### Events Emitted
- `operation:start`: `{ type: 'findOne', collection }`
- `operation:success`: `{ type: 'findOne', collection, result }`
- `operation:error`: `{ type: 'findOne', collection, error }`

#### Examples
##### Simple Example: Find One Record
```javascript
const result = await db.findOne('users', { name: 'John' });
console.log(result.data); // { id: 'user123', name: 'John', age: 30 }
```

##### Complex Example: Find with Nested Filter
```javascript
const result = await db.findOne('users', { 'address.city': 'Boston' });
console.log(result.data); // First user in Boston
```

##### Example with Fallback
```javascript
const result = await db.findOne('users', { email: 'john@example.com' });
if (result.data) {
  console.log('User found:', result.data);
} else {
  console.log('No user found, creating...');
  await db.set('users', 'user123', { email: 'john@example.com', name: 'John' });
}
```

---

### 9. `search(collectionName, term, fields, options)`
Searches records using a search term.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `term` (String, **required**): Search term.
- `fields` (Array, optional): Fields to search in.
- `options` (Object, optional): Same as `get` options (`sort`, `limit`, `offset`).

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Array): Matching records.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'search', collection }`
- `operation:success`: `{ type: 'search', collection, result }`
- `operation:error`: `{ type: 'search', collection, error }`

#### Examples
##### Simple Example: Basic Search
```javascript
const result = await db.search('products', 'laptop');
console.log(result.data); // [{ id: 'prod1', name: 'Laptop Pro', ... }, ...]
```

##### Complex Example: Search with Fields
```javascript
const result = await db.search('products', 'laptop', ['name', 'description'], {
  sort: 'price:desc',
  limit: 5,
  offset: 10
});
console.log(result.data); // Top 5 laptops, sorted by price
```

##### Example with Event Listener
```javascript
db.on('operation:success', ({ type, result }) => {
  if (type === 'search') console.log('Search results:', result.data);
});
await db.search('users', 'john', ['name', 'email']);
```

---

### 10. `count(collectionName, filter)`
Counts records matching a filter.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `filter` (Object, optional): Filter criteria.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Number): Number of matching records.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'count', collection }`
- `operation:success`: `{ type: 'count', collection, result }`
- `operation:error`: `{ type: 'count', collection, error }`

#### Examples
##### Simple Example: Count All Records
```javascript
const result = await db.count('users');
console.log(result.data); // e.g., 100
```

##### Complex Example: Count with Filter
```javascript
const result = await db.count('users', { status: 'active', age: { $gte: 18 } });
console.log(result.data); // e.g., 42
```

##### Example with Conditional Logic
```javascript
const count = await db.count('products', { stock: { $gt: 0 } });
if (count.data > 0) {
  console.log(`${count.data} products in stock`);
} else {
  console.log('No products in stock');
}
```

---

### 11. `paginate(collectionName, page, perPage, options)`
Retrieves records with pagination.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `page` (Number, **required**): Page number (1-based).
- `perPage` (Number, **required**): Records per page.
- `options` (Object, optional): Same as `get` options.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Array): Records for the page.
  - `meta` (Object): Metadata including `operation`, `collection`, `totalCount`, `actualPage`, `maxPage`, `perPage`, `hasNextPage`, `hasPrevPage`.

#### Events Emitted
- `operation:start`: `{ type: 'paginate', collection }`
- `operation:success`: `{ type: 'paginate', collection, result }`
- `operation:error`: `{ type: 'paginate', collection, error }`

#### Examples
##### Simple Example: Basic Pagination
```javascript
const result = await db.paginate('users', 1, 10);
console.log(result.data); // First 10 users
console.log(result.meta); // { totalCount: 50, actualPage: 1, maxPage: 5, ... }
```

##### Complex Example: Paginate with Filter
```javascript
const result = await db.paginate('products', 2, 5, {
  filter: { category: 'electronics', price: { $lte: 1000 } },
  sort: 'price:asc'
});
console.log(result.data); // 5 products from page 2
console.log(result.meta.hasNextPage); // true or false
```

##### Example with Navigation
```javascript
let page = 1;
const perPage = 10;
const result = await db.paginate('users', page, perPage);
console.log(`Page ${page}:`, result.data);
if (result.meta.hasNextPage) {
  page++;
  const nextPage = await db.paginate('users', page, perPage);
  console.log(`Page ${page}:`, nextPage.data);
}
```

---

### 12. `increment(collectionName, id, field, amount)`
Increments a numeric field.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `id` (String, **required**): The record ID.
- `field` (String, **required**): The field to increment.
- `amount` (Number, optional): Increment amount. Defaults to `1`.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Object): Updated record.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'increment', collection, id }`
- `operation:success`: `{ type: 'increment', collection, id, result }`
- `operation:error`: `{ type: 'increment', collection, id, error }`
- `record:updated`: `{ collection, id, data }`

#### Examples
##### Simple Example: Increment a Counter
```javascript
const result = await db.increment('users', 'user123', 'loginCount');
console.log(result.data); // { id: 'user123', loginCount: 6, ... }
```

##### Complex Example: Increment by Custom Amount
```javascript
const result = await db.increment('products', 'prod1', 'stock', 10);
console.log(result.data); // { id: 'prod1', stock: 110, ... }
```

##### Example with Event Listener
```javascript
db.on('record:updated', ({ collection, id, data }) => {
  console.log(`Updated ${id} in ${collection}:`, data);
});
await db.increment('users', 'user123', 'score', 5);
```

---

### 13. `decrement(collectionName, id, field, amount)`
Decrements a numeric field.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `id` (String, **required**): The record ID.
- `field` (String, **required**): The field to decrement.
- `amount` (Number, optional): Decrement amount. Defaults to `1`.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Object): Updated record.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'decrement', collection, id }`
- `operation:success`: `{ type: 'decrement', collection, id, result }`
- `operation:error`: `{ type: 'decrement', collection, id, error }`
- `record:updated`: `{ collection, id, data }`

#### Examples
##### Simple Example: Decrement a Counter
```javascript
const result = await db.decrement('users', 'user123', 'loginCount');
console.log(result.data); // { id: 'user123', loginCount: 5, ... }
```

##### Complex Example: Decrement by Custom Amount
```javascript
const result = await db.decrement('products', 'prod1', 'stock', 5);
console.log(result.data); // { id: 'prod1', stock: 95, ... }
```

##### Example with Validation
```javascript
const product = await db.get('products', 'prod1');
if (product.data.stock >= 5) {
  await db.decrement('products', 'prod1', 'stock', 5);
  console.log('Stock reduced');
} else {
  console.log('Insufficient stock');
}
```

---

### 14. `batchSet(collectionName, records)`
Creates or updates multiple records.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `records` (Array, **required**): Array of objects with `id` and data.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Array): Operation results.
  - `meta` (Object): Metadata including `operation`, `collection`, `total`, `errors`.

#### Events Emitted
- `operation:start`: `{ type: 'batchSet', collection }`
- `operation:success`: `{ type: 'batchSet', collection, result }`
- `operation:error`: `{ type: 'batchSet', collection, error }`
- `record:created`: `{ collection, id, data }` (per created record)
- `record:updated`: `{ collection, id, data }` (per updated record)

#### Examples
##### Simple Example: Batch Create
```javascript
const records = [
  { id: 'user123', name: 'John', age: 30 },
  { id: 'user456', name: 'Jane', age: 25 }
];
const result = await db.batchSet('users', records);
console.log(result.data); // [{ status: 'success', id: 'user123', ... }, ...]
```

##### Complex Example: Batch Update
```javascript
const records = [
  { id: 'prod1', stock: 100, price: 999.99 },
  { id: 'prod2', stock: 50, price: 499.99 }
];
const result = await db.batchSet('products', records);
console.log(result.meta.errors); // Any errors during batch operation
```

##### Example with Event Listener
```javascript
db.on('record:created', ({ id, data }) => console.log(`Created ${id}:`, data));
await db.batchSet('users', [
  { id: 'user789', name: 'Alice', role: 'admin' },
  { id: 'user012', name: 'Bob', role: 'user' }
]);
```

---

### 15. `batchGet(collectionName, ids)`
Retrieves multiple records by IDs.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `ids` (Array, **required**): Array of record IDs.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Array): Retrieved records.
  - `meta` (Object): Metadata including `operation`, `collection`, `total`, `errors`.

#### Events Emitted
- `operation:start`: `{ type: 'batchGet', collection }`
- `operation:success`: `{ type: 'batchGet', collection, result }`
- `operation:error`: `{ type: 'batchGet', collection, error }`

#### Examples
##### Simple Example: Batch Retrieve
```javascript
const result = await db.batchGet('users', ['user123', 'user456']);
console.log(result.data); // [{ id: 'user123', ... }, { id: 'user456', ... }]
```

##### Complex Example: Batch with Missing IDs
```javascript
const result = await db.batchGet('products', ['prod1', 'prod2', 'nonexistent']);
console.log(result.data); // [{ id: 'prod1', ... }, { id: 'prod2', ... }, null]
console.log(result.meta.errors); // Errors for 'nonexistent'
```

---

### 16. `batchDelete(collectionName, ids)`
Deletes multiple records by IDs.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `ids` (Array, **required**): Array of record IDs.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Array): Operation results.
  - `meta` (Object): Metadata including `operation`, `collection`, `total`, `errors`.

#### Events Emitted
- `operation:start`: `{ type: 'batchDelete', collection }`
- `operation:success`: `{ type: 'batchDelete', collection, result }`
- `operation:error`: `{ type: 'batchDelete', collection, error }`
- `record:deleted`: `{ collection, key }` (per deleted record)

#### Examples
##### Simple Example: Batch Delete
```javascript
const result = await db.batchDelete('users', ['user123', 'user456']);
console.log(result.data); // [{ status: 'success', id: 'user123' }, ...]
```

##### Complex Example: Batch Delete with Event
```javascript
db.on('record:deleted', ({ collection, key }) => console.log(`Deleted ${key} from ${collection}`));
await db.batchDelete('products', ['prod1', 'prod2']);
```

---

### 17. `batchUpdate(collectionName, updates)`
Updates multiple records.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `updates` (Array, **required**): Array of objects with `id` and fields to update.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Array): Operation results.
  - `meta` (Object): Metadata including `operation`, `collection`, `total`, `errors`.

#### Events Emitted
- `operation:start`: `{ type: 'batchUpdate', collection }`
- `operation:success`: `{ type: 'batchUpdate', collection, result }`
- `operation:error`: `{ type: 'batchUpdate', collection, error }`
- `record:updated`: `{ collection, id, data }` (per updated record)

#### Examples
##### Simple Example: Batch Update
```javascript
const updates = [
  { id: 'user123', age: 31 },
  { id: 'user456', age: 26 }
];
const result = await db.batchUpdate('users', updates);
console.log(result.data); // [{ status: 'success', id: 'user123', ... }, ...]
```

##### Complex Example: Batch Update with Nested Fields
```javascript
const updates = [
  { id: 'user123', address: { city: 'Boston' } },
  { id: 'user456', tags: ['active', 'premium'] }
];
const result = await db.batchUpdate('users', updates);
console.log(result.data); // Updated records
```

---

### 18. `keys(collectionName, options)`
Retrieves all record IDs in a collection.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `options` (Object, optional): Additional options (API-dependent).

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Array): Array of record IDs.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'keys', collection }`
- `operation:success`: `{ type: 'keys', collection, result }`
- `operation:error`: `{ type: 'keys', collection, error }`

#### Examples
##### Simple Example: Get All Keys
```javascript
const result = await db.keys('users');
console.log(result.data); // ['user123', 'user456', ...]
```

##### Example with Processing
```javascript
const keys = await db.keys('products');
for (const key of keys.data) {
  const product = await db.get('products', key);
  console.log(`Product ${key}:`, product.data);
}
```

---

### 19. `values(collectionName, options)`
Retrieves all records (alias for `get` with no `key`).

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `options` (Object, optional): Same as `get` options.

#### Returns
- Same as `get`.

#### Events Emitted
- Same as `get`.

#### Examples
##### Simple Example: Get All Records
```javascript
const result = await db.values('users');
console.log(result.data); // [{ id: 'user123', ... }, ...]
```

##### Complex Example: Filtered Values
```javascript
const result = await db.values('products', {
  filter: { category: 'electronics' },
  fields: ['name', 'price']
});
console.log(result.data); // [{ name: 'Laptop', price: 999.99 }, ...]
```

---

### 20. `entries(collectionName, options)`
Retrieves records as key-value pairs.

#### Parameters
- `collectionName` (String, **required**): The collection name.
- `options` (Object, optional): Additional options (API-dependent).

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Array): Array of key-value pairs.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'entries', collection }`
- `operation:success`: `{ type: 'entries', collection, result }`
- `operation:error`: `{ type: 'entries', collection, error }`

#### Examples
##### Simple Example: Get Entries
```javascript
const result = await db.entries('users');
console.log(result.data); // [{ key: 'user123', value: { ... } }, ...]
```

##### Example with Processing
```javascript
const entries = await db.entries('products');
entries.data.forEach(({ key, value }) => {
  console.log(`Product ${key}:`, value);
});
```

---

### 21. `size(collectionName)`
Gets the number of records in a collection.

#### Parameters
- `collectionName` (String, **required**): The collection name.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Number): Number of records.
  - `meta` (Object, optional): Metadata like `operation`, `collection`.

#### Events Emitted
- `operation:start`: `{ type: 'size', collection }`
- `operation:success`: `{ type: 'size', collection, result }`
- `operation:error`: `{ type: 'size', collection, error }`

#### Examples
##### Simple Example: Get Collection Size
```javascript
const result = await db.size('users');
console.log(result.data); // e.g., 100
```

##### Example with Conditional Logic
```javascript
const size = await db.size('products');
if (size.data > 1000) {
  console.log('Large collection, consider pagination');
} else {
  const records = await db.values('products');
  console.log(records.data);
}
```

---

### 22. `health()`
Checks the database health.

#### Parameters
- None.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Object): Health status information.
  - `meta` (Object, optional): Metadata like `operation`.

#### Events Emitted
- `health:check`: `{ status: 'healthy' | 'unhealthy', result | error }`

#### Examples
##### Simple Example: Check Health
```javascript
const result = await db.health();
console.log(result.data); // { status: 'ok', ... }
```

##### Example with Event Listener
```javascript
db.on('health:check', ({ status, result }) => {
  console.log(`Database is ${status}:`, result || result.error);
});
await db.health();
```

---

### 23. `ping()`
Measures database latency.

#### Parameters
- None.

#### Returns
- `Promise<Object>`:
  - `success` (Boolean): Operation success status.
  - `data` (Number): Latency in milliseconds.
  - `meta` (Object, optional): Metadata like `operation`.

#### Events Emitted
- `operation:success`: `{ type: 'ping', latency }`
- `operation:error`: `{ type: 'ping', error }`

#### Examples
##### Simple Example: Check Latency
```javascript
const result = await db.ping();
console.log(result.data); // e.g., 50 (milliseconds)
```

##### Example with Threshold
```javascript
const result = await db.ping();
if (result.data > 100) {
  console.warn('High latency:', result.data, 'ms');
} else {
  console.log('Acceptable latency:', result.data, 'ms');
}
```

---

### 24. `getConnectionInfo()`
Gets connection information.

#### Parameters
- None.

#### Returns
- `Object`:
  - `success` (Boolean): `true`.
  - `data` (Object): Connection details (`URI`, `token`, `projectId`, `permissions`, `collections`, `timeout`, `retryAttempts`, `retryDelay`).
  - `meta` (Object): Metadata with `operation: 'connectionInfo'`.

#### Examples
##### Simple Example: Get Connection Info
```javascript
const info = db.getConnectionInfo();
console.log(info.data); // { URI: 'http://localhost:6050', token: '...', ... }
```

##### Example with Validation
```javascript
const info = db.getConnectionInfo();
if (info.data.permissions === 'read') {
  console.warn('Read-only access, write operations will fail');
} else {
  await db.set('users', 'user123', { name: 'John' });
}
```

---

### EventEmitter Methods
`liekoDB` inherits from `EventEmitter`, providing the following methods:

#### 25. `on(event, listener)`
Registers a listener for an event.

##### Parameters
- `event` (String): Event name.
- `listener` (Function): Callback function.

##### Returns
- `liekoDB`: Instance for chaining.

##### Examples
##### Simple Example: Listen for Ready Event
```javascript
db.on('ready', () => console.log('Database ready'));
```

##### Complex Example: Monitor Operations
```javascript
db.on('operation:success', ({ type, collection, result }) => {
  console.log(`Operation ${type} on ${collection} succeeded:`, result.data);
});
await db.get('users', 'user123');
```

---

#### 26. `once(event, listener)`
Registers a one-time listener.

##### Parameters
- `event` (String): Event name.
- `listener` (Function): Callback function.

##### Returns
- `liekoDB`: Instance for chaining.

##### Examples
##### Simple Example: One-Time Listener
```javascript
db.once('ready', () => console.log('Database ready (once)'));
```

##### Complex Example: One-Time Error Handling
```javascript
db.once('operation:error', ({ type, collection, error }) => {
  console.error(`Error in ${type} on ${collection}:`, error);
});
await db.get('users', 'nonexistent');
```

---

#### 27. `off(event, listener)`
Removes a listener.

##### Parameters
- `event` (String): Event name.
- `listener` (Function): Listener to remove.

##### Returns
- `liekoDB`: Instance for chaining.

##### Examples
##### Simple Example: Remove Listener
```javascript
const listener = () => console.log('Operation started');
db.on('operation:start', listener);
db.off('operation:start', listener);
```

##### Complex Example: Conditional Removal
```javascript
const errorListener = ({ type, error }) => console.error(`Error in ${type}:`, error);
db.on('operation:error', errorListener);
const result = await db.health();
if (result.data.status === 'ok') {
  db.off('operation:error', errorListener);
}
```

---

#### 28. `removeAllListeners(event)`
Removes all listeners for an event or all events.

##### Parameters
- `event` (String, optional): Event name. If omitted, removes all listeners.

##### Returns
- `liekoDB`: Instance for chaining.

##### Examples
##### Simple Example: Remove All for Event
```javascript
db.removeAllListeners('operation:start');
```

##### Complex Example: Reset All Listeners
```javascript
db.removeAllListeners();
console.log('All listeners removed, reinitializing...');
db.on('ready', () => console.log('Database ready'));
```

---

#### 29. `listenerCount(event)`
Gets the number of listeners for an event.

##### Parameters
- `event` (String): Event name.

##### Returns
- `Number`: Number of listeners.

##### Examples
##### Simple Example: Count Listeners
```javascript
console.log(db.listenerCount('operation:start')); // e.g., 2
```

##### Complex Example: Monitor Listeners
```javascript
db.on('operation:start', () => console.log('Start 1'));
db.on('operation:start', () => console.log('Start 2'));
console.log(db.listenerCount('operation:start')); // 2
db.removeAllListeners('operation:start');
console.log(db.listenerCount('operation:start')); // 0
```

---

## Error Handling
All methods throw `DatabaseError` on failure:

```javascript
class DatabaseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DatabaseError';
    this.code = details.code; // e.g., 'RECORD_NOT_FOUND'
    this.status = details.status; // e.g., 404
    this.operation = details.operation; // e.g., 'get'
    this.collection = details.collection; // e.g., 'users'
    this.key = details.key; // e.g., 'user123'
    this.timestamp = new Date().toISOString();
  }
}
```

### Example
```javascript
try {
  await db.get('users', 'nonexistent', { throwOnNotFound: true });
} catch (error) {
  console.error(error.toJSON());
  // { name: 'DatabaseError', message: "Record 'nonexistent' not found in collection 'users'", ... }
}
```

## Supported Events
- `connecting`: During connection initialization.
- `token:validated`: After token validation with `{ projectId, permissions, collections, projectName }`.
- `ready`: When client is ready with `liekoDB` instance.
- `error`: On initialization errors with `Error`.
- `operation:start`: On operation start with `{ type, collection, key/id }`.
- `operation:success`: On operation success with `{ type, collection, key/id, result }`.
- `operation:error`: On operation errors with `{ type, collection, key/id, error }`.
- `record:created`: On record creation with `{ collection, id, data }`.
- `record:updated`: On record update with `{ collection, id, data }`.
- `record:deleted`: On record deletion with `{ collection, key }`.
- `request:completed`: On successful requests with request details.
- `request:failed`: On failed requests with error details.
- `health:check`: After health checks with `{ status, result/error }`.

## Notes
- **Retry Mechanism**: Retries on timeouts, connection errors, or server errors (500-599) up to `retryAttempts` times.
- **Permissions**: Operations respect token permissions (`read`, `write`, `full`).
- **Debug Logging**: Enable with `debug: true` for detailed logs.
- **Non-Throwing 404s**: If `throwOnNotFound` is `false`, 404s return error responses.
- **Search Filters**: `get` supports `$search` filters via the `/search` endpoint.
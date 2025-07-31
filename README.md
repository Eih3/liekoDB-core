# liekoDB Client Documentation

This documentation provides examples of how to use the `liekoDB` client library to interact with a liekoDB server. The library provides methods for managing data in collections, including operations like setting, getting, checking existence, batch operations, searching, and retrieving data in various formats.

## Table of Contents
- [Installation](#installation)
- [Initialization](#initialization)
- [Basic Operations](#basic-operations)
  - [Set a Record](#set-a-record)
  - [Get a Record](#get-a-record)
  - [Check Existence (Has)](#check-existence-has)
  - [Delete a Record](#delete-a-record)
  - [Clear a Collection](#clear-a-collection)
- [Batch Operations](#batch-operations)
  - [Batch Set](#batch-set)
  - [Batch Get](#batch-get)
  - [Batch Update](#batch-update)
  - [Batch Delete](#batch-delete)
- [Query Operations](#query-operations)
  - [Find Records](#find-records)
  - [Find One Record](#find-one-record)
  - [Search Records](#search-records)
  - [Count Records](#count-records)
  - [Paginate Records](#paginate-records)
- [Advanced Operations](#advanced-operations)
  - [Increment/Decrement a Field](#incrementdecrement-a-field)
  - [Get Keys](#get-keys)
  - [Get Values](#get-values)
  - [Get Entries](#get-entries)
  - [Get Collection Size](#get-collection-size)
  - [Iterate Over Records](#iterate-over-records)
- [Data Format Options](#data-format-options)
  - [Get as Array](#get-as-array)
  - [Get as Object](#get-as-object)
- [Event Handling](#event-handling)
- [Health and Connection](#health-and-connection)
  - [Check Health](#check-health)
  - [Ping Server](#ping-server)
  - [Get Connection Info](#get-connection-info)
- [Examples App](#examples-app)

## Online Documentation
[LiekoDB Documentation](http://gnode01.pyts-cloud.fr:9700/doc.html)


## Installation

Install the `liekoDB` client library in a Node.js environment:

```bash
npm install liekodb
```

Or include it in a browser environment via a script tag (assuming the server exposes the client script):

```html
<script src="http://your-liekodb-server/liekoDB.js"></script>
```

## Initialization

To use `liekoDB`, initialize the client with a project token and optionally specify the database URL and other configuration options.

```javascript
const liekoDB = require('liekodb');

const db = new liekoDB({
  token: 'your-project-token',
  databaseUrl: 'http://localhost:6050',
  debug: true, // Enable debug logging
  timeout: 5000, // Request timeout in milliseconds
  retryAttempts: 3, // Number of retry attempts for failed requests
  retryDelay: 1000 // Delay between retries in milliseconds
});

// Wait for the database to be ready
db.on('ready', () => {
  console.log('Database connection established');
});

// Handle errors
db.on('error', (error) => {
  console.error('Database error:', error.message);
});
```

## Basic Operations

### Set a Record

The `set` method creates or updates a record in a collection. If the record doesn't exist, it creates a new one; otherwise, it updates the existing record.

```javascript
async function setRecord() {
  try {
    const result = await db.set('users', 'user123', {
      name: 'John Doe',
      email: 'john@example.com',
      age: 30
    });
    console.log('Record set:', result);
  } catch (error) {
    console.error('Error setting record:', error.message);
  }
}
setRecord();
```

### Get a Record

The `get` method retrieves a single record by its ID or all records in a collection.

```javascript
async function getRecord() {
  try {
    // Get a single record
    const user = await db.get('users', 'user123');
    console.log('Single record:', user);

    // Get all records in a collection
    const allUsers = await db.get('users');
    console.log('All users:', allUsers);
  } catch (error) {
    console.error('Error getting record:', error.message);
  }
}
getRecord();
```

### Check Existence (Has)

The `has` method checks if a record exists in a collection by its ID.

```javascript
async function checkRecord() {
  try {
    const exists = await db.has('users', 'user123');
    console.log('Record exists:', exists); // true or false
  } catch (error) {
    console.error('Error checking record:', error.message);
  }
}
checkRecord();
```

### Delete a Record

The `delete` method removes a record from a collection by its ID.

```javascript
async function deleteRecord() {
  try {
    const success = await db.delete('users', 'user123');
    console.log('Record deleted:', success); // true if deleted, false if not found
  } catch (error) {
    console.error('Error deleting record:', error.message);
  }
}
deleteRecord();
```

### Clear a Collection

The `clear` method removes all records from a collection.

```javascript
async function clearCollection() {
  try {
    await db.clear('users');
    console.log('Collection cleared');
  } catch (error) {
    console.error('Error clearing collection:', error.message);
  }
}
clearCollection();
```

## Batch Operations

### Batch Set

The `batchSet` method creates or updates multiple records in a single request.

```javascript
async function batchSetRecords() {
  try {
    const records = [
      { id: 'user1', name: 'Alice', email: 'alice@example.com' },
      { id: 'user2', name: 'Bob', email: 'bob@example.com' }
    ];
    const result = await db.batchSet('users', records);
    console.log('Batch set results:', result);
    // Example output: { results: [{ id: 'user1', status: 'success', record: {...} }, ...], errors: [], total: 2 }
  } catch (error) {
    console.error('Error in batch set:', error.message);
  }
}
batchSetRecords();
```

### Batch Get

The `batchGet` method retrieves multiple records by their IDs in a single request.

```javascript
async function batchGetRecords() {
  try {
    const keys = ['user1', 'user2'];
    const result = await db.batchGet('users', keys);
    console.log('Batch get results:', result);
    // Example output: { results: [{ id: 'user1', name: 'Alice', ...}, ...], errors: [], total: 2 }
  } catch (error) {
    console.error('Error in batch get:', error.message);
  }
}
batchGetRecords();
```

### Batch Update

The `batchUpdate` method updates multiple records in a single request.

```javascript
async function batchUpdateRecords() {
  try {
    const updates = [
      { id: 'user1', updates: { age: 25 } },
      { id: 'user2', updates: { age: 30 } }
    ];
    const result = await db.batchUpdate('users', updates);
    console.log('Batch update results:', result);
    // Example output: { results: [{ id: 'user1', status: 'success', record: {...} }, ...], errors: [], total: 2 }
  } catch (error) {
    console.error('Error in batch update:', error.message);
  }
}
batchUpdateRecords();
```

### Batch Delete

The `batchDelete` method deletes multiple records by their IDs in a single request.

```javascript
async function batchDeleteRecords() {
  try {
    const keys = ['user1', 'user2'];
    const result = await db.batchDelete('users', keys);
    console.log('Batch delete results:', result);
    // Example output: { results: [{ key: 'user1', status: 'success' }, ...], errors: [], total: 2 }
  } catch (error) {
    console.error('Error in batch delete:', error.message);
  }
}
batchDeleteRecords();
```

## Query Operations

### Find Records

The `find` method retrieves records matching a filter, with optional sorting and pagination.

```javascript
async function findRecords() {
  try {
    const filter = { age: 30 };
    const options = {
      sort: 'name:asc', // Sort by name in ascending order
      limit: 10, // Limit to 10 records
      offset: 0 // Start from the first record
    };
    const results = await db.find('users', filter, options);
    console.log('Found records:', results);
  } catch (error) {
    console.error('Error finding records:', error.message);
  }
}
findRecords();
```

### Find One Record

The `findOne` method retrieves the first record matching a filter.

```javascript
async function findOneRecord() {
  try {
    const filter = { email: 'john@example.com' };
    const result = await db.findOne('users', filter);
    console.log('Found one record:', result);
  } catch (error) {
    console.error('Error finding one record:', error.message);
  }
}
findOneRecord();
```

### Search Records

The `search` method performs a text search across specified fields in a collection.

```javascript
async function searchRecords() {
  try {
    const term = 'John';
    const fields = ['name', 'email'];
    const options = { sort: 'name:asc', limit: 10 };
    const results = await db.search('users', term, fields, options);
    console.log('Search results:', results);
  } catch (error) {
    console.error('Error searching records:', error.message);
  }
}
searchRecords();
```

### Count Records

The `count` method returns the number of records matching a filter.

```javascript
async function countRecords() {
  try {
    const filter = { age: { $gt: 25 } };
    const count = await db.count('users', filter);
    console.log('Record count:', count);
  } catch (error) {
    console.error('Error counting records:', error.message);
  }
}
countRecords();
```

### Paginate Records

The `paginate` method retrieves records in pages, useful for large datasets.

```javascript
async function paginateRecords() {
  try {
    const page = 1;
    const perPage = 10;
    const options = { filter: { age: { $gte: 18 } }, sort: 'name:asc' };
    const result = await db.paginate('users', page, perPage, options);
    console.log('Paginated records:', result);
    // Example output: { data: [...], totalCount: 50 }
  } catch (error) {
    console.error('Error paginating records:', error.message);
  }
}
paginateRecords();
```

## Advanced Operations

### Increment/Decrement a Field

The `increment` and `decrement` methods adjust a numeric field in a record.

```javascript
async function incrementField() {
  try {
    const result = await db.increment('users', 'user123', 'age', 1);
    console.log('Incremented record:', result);
  } catch (error) {
    console.error('Error incrementing field:', error.message);
  }
}

async function decrementField() {
  try {
    const result = await db.decrement('users', 'user123', 'age', 1);
    console.log('Decremented record:', result);
  } catch (error) {
    console.error('Error decrementing field:', error.message);
  }
}
incrementField();
decrementField();
```

### Get Keys

The `keys` method retrieves all record IDs in a collection.

```javascript
async function getKeys() {
  try {
    const keys = await db.keys('users');
    console.log('Collection keys:', keys);
  } catch (error) {
    console.error('Error getting keys:', error.message);
  }
}
getKeys();
```

### Get Values

The `values` method retrieves all records in a collection as an array.

```javascript
async function getValues() {
  try {
    const values = await db.values('users', { sort: 'name:asc' });
    console.log('Collection values:', values);
  } catch (error) {
    console.error('Error getting values:', error.message);
  }
}
getValues();
```

### Get Entries

The `entries` method retrieves all records as key-value pairs.

```javascript
async function getEntries() {
  try {
    const entries = await db.entries('users');
    console.log('Collection entries:', entries);
  } catch (error) {
    console.error('Error getting entries:', error.message);
  }
}
getEntries();
```

### Get Collection Size

The `size` method returns the number of records in a collection.

```javascript
async function getSize() {
  try {
    const size = await db.size('users');
    console.log('Collection size:', size);
  } catch (error) {
    console.error('Error getting size:', error.message);
  }
}
getSize();
```

### Iterate Over Records

The `iterator` method provides an async iterator for streaming records.

```javascript
async function iterateRecords() {
  try {
    const iterator = await db.iterator('users', { perPage: 10 });
    for await (const record of iterator) {
      console.log('Record:', record);
    }
  } catch (error) {
    console.error('Error iterating records:', error.message);
  }
}
iterateRecords();
```

## Data Format Options

### Get as Array

By default, collections like `users`, `profiles`, `accounts`, and `settings` return data as objects (keyed by ID). To force an array output, use the `returnType` option.

```javascript
async function getAsArray() {
  try {
    const users = await db.get('users', null, { returnType: 'array' });
    console.log('Users as array:', users);
  } catch (error) {
    console.error('Error getting as array:', error.message);
  }
}
getAsArray();
```

### Get as Object

To force object output for collections not in the default object-based patterns, use the `returnType` option.

```javascript
async function getAsObject() {
  try {
    const data = await db.get('products', null, { returnType: 'object' });
    console.log('Products as object:', data);
  } catch (error) {
    console.error('Error getting as object:', error.message);
  }
}
getAsObject();
```

## Event Handling

The `liekoDB` client emits various events that you can listen to for monitoring operations.

```javascript
// Connection events
db.on('connecting', () => console.log('Connecting to database...'));
db.on('ready', () => console.log('Database ready'));
db.on('disconnected', () => console.log('Database disconnected'));
db.on('error', (error) => console.error('Database error:', error.message));

// Operation events
db.on('operation:start', ({ type, collection, key }) => {
  console.log(`Starting ${type} operation on ${collection}${key ? `/${key}` : ''}`);
});
db.on('operation:success', ({ type, collection, result }) => {
  console.log(`Completed ${type} on ${collection}:`, result);
});
db.on('operation:error', ({ type, collection, error }) => {
  console.error(`Failed ${type} on ${collection}:`, error.message);
});

// Record events
db.on('record:created', ({ collection, id, data }) => {
  console.log(`Record created in ${collection} with ID ${id}:`, data);
});
db.on('record:updated', ({ collection, id, data }) => {
  console.log(`Record updated in ${collection} with ID ${id}:`, data);
});
db.on('record:deleted', ({ collection, key }) => {
  console.log(`Record deleted from ${collection} with key ${key}`);
});

// Request events
db.on('request:completed', (log) => {
  console.log(`Request completed: ${log.method} ${log.endpoint} (${log.status}, ${log.durationHuman})`);
});
db.on('request:failed', (log) => {
  console.error(`Request failed: ${log.method} ${log.endpoint} (${log.error})`);
});
```

## Health and Connection

### Check Health

The `health` method checks the server’s health status.

```javascript
async function checkHealth() {
  try {
    const health = await db.health();
    console.log('Server health:', health);
  } catch (error) {
    console.error('Error checking health:', error.message);
  }
}
checkHealth();
```

### Ping Server

The `ping` method measures the server’s response time.

```javascript
async function pingServer() {
  try {
    const latency = await db.ping();
    console.log('Server latency:', latency, 'ms');
  } catch (error) {
    console.error('Error pinging server:', error.message);
  }
}
pingServer();
```

### Get Connection Info

The `getConnectionInfo` method returns the current connection details.

```javascript
function getConnectionInfo() {
  const info = db.getConnectionInfo();
  console.log('Connection info:', info);
}
getConnectionInfo();
```

### Examples App

Simple test with connection DB and user manipulations

```javascript
const db = new (require('liekodb'))({
    databaseUrl: 'http://gnode01.pyts-cloud.fr:9700',
    token: '108f4e86c17f5e950e7ffdd50ab4d8fd99bc56b3c43fa3d827ed558f1650afde',
    debug: true
});

function waitForReady(db) {
    return new Promise((resolve, reject) => {
        if (db.isReady) return resolve(); // already ready
        db.once('ready', resolve);
        db.once('error', reject);
    });
}

(async () => {
    try {
        await waitForReady(db); // Wait for the database to be ready

        await db.clear("users");
        console.log("Users collection cleared");

        await db.set('users', 'user1', { name: 'John Doe', age: 30 });
        console.log('User created successfully');

        console.log('Fetching user data...');
        console.log(await db.get('users', 'user1'));

        const result = await db.delete('users', 'user1');
        console.log(`User deleted successfully: ${JSON.stringify(result)}`);

        console.log('Fetching user data...');
        console.log(await db.get('users', 'user1'));
    } catch (error) {
        console.error(`Database operation failed: ${error.message}`);
    }
})();
```

Other simple example

```javascript
const liekoDB = require('liekodb');

const db = new liekoDB({
    databaseUrl: 'http://gnode01.pyts-cloud.fr:9700',
    token: '108f4e86c17f5e950e7ffdd50ab4d8fd99bc56b3c43fa3d827ed558f1650afde',
    debug: true
});

testConnection();

db.on('connecting', () => {
    console.log('Connecting to database...');
});

db.on('ready', () => {
    console.log('Database is ready!');
});

db.clear("users").then(() => {
    console.log("Users collection cleared");
}).catch((error) => {
    console.error(`Failed to clear users collection: ${error.message}`);
});

db.set('users', 'user1', { name: 'John Doe', age: 30 })
    .then(async () => {
        console.log('User created successfully');
        console.log('Fetching user data...');
        console.log(await db.get('users', 'user1'));
    })
    .then(async () => {
        const result = await db.delete('users', 'user1');
        console.log(`User deleted successfully: ${JSON.stringify(result)}`);
        console.log('Fetching user data...');
        console.log(await db.get('users', 'user1'));
    })
    .catch((error) => {
        console.error(`Failed to create user: ${error.message}`);
    });


async function testConnection() {
    try {
        const result = await db.health();
        console.log(`Health check: ${JSON.stringify(result)}`);
    } catch (error) {
        console.error(`Health check failed: ${error.message}`);
    }
}


async function createUser() {
    try {
        const userId = 'user_' + Date.now();
        const userData = {
            name: 'John Doe',
            email: 'john@example.com',
            age: 30,
            createdAt: new Date().toISOString()
        };
        const result = await db.set('users', userId, userData);
        console.log(`User created: ${JSON.stringify(result, null, 2)}`);
    } catch (error) {
        console.error(`Failed to create user: ${error.message}`);
    }
}


createUser();

/**
 * Collection Creation: The db.set() method automatically calls ensureCollection('users'), so the 'users' collection is created if it doesn't exist.
 */
```


[LiekoDB Demo (html)](http://gnode01.pyts-cloud.fr:9700/examples/liekoDB_demo.html)

[LiekoDB Tester (html)](http://gnode01.pyts-cloud.fr:9700/examples/liekoDB_tester.html)

[LiekoDB Users App (html)](http://gnode01.pyts-cloud.fr:9700/examples/users-app.html)

[LiekoDB Users Dashboard (html)](http://gnode01.pyts-cloud.fr:9700/examples/users-dashboard.html)

## Notes

- **Permissions**: Ensure the project token has the necessary permissions (`read`, `write`, or `full`) for the operations you want to perform. Some operations (e.g., `clear`, `batchDelete`) require `full` permissions.
- **Error Handling**: Always wrap operations in try-catch blocks to handle potential errors, such as network issues or permission errors.
- **Debug Mode**: Enable the `debug` option during initialization to log detailed request and response information.
- **Collection Creation**: The `ensureCollection` method is called automatically for write operations to create collections if they don’t exist.
- **Async/Await**: All methods that interact with the server are asynchronous and return Promises.

This documentation covers the core functionality of the `liekoDB` client. For advanced use cases or server-side configuration, refer to the server documentation or contact the liekoDB server administrator.
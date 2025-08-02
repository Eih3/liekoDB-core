# LiekoDB Server

![LiekoDB Logo](https://via.placeholder.com/150) <!-- Replace with actual logo if available -->

**LiekoDB Server** is a lightweight, JSON-based database server built with Node.js and Express. It provides a RESTful API for managing collections and records, supporting CRUD operations, text search, batch processing, and pagination. Designed for simplicity and performance, LiekoDB is ideal for small to medium-sized applications, prototyping, or as a backend for web and mobile apps. It pairs seamlessly with the [LiekoDB JavaScript Client](https://github.com/your-repo/liekoDB-client) for a complete database solution.

## Features

- **JSON Storage**: Stores data as JSON files for simplicity and portability.
- **RESTful API**: Exposes endpoints for creating, reading, updating, and deleting records.
- **Text Search**: Supports case-insensitive search across all or specified fields.
- **Batch Operations**: Efficiently handle multiple records in a single request.
- **Pagination**: Retrieve large datasets with limit and offset controls.
- **Authentication**: Uses token-based authentication for secure access.
- **Lightweight**: Minimal dependencies (Express, CORS, UUID) for fast setup.

## Table of Contents

1. [Installation](#installation)
   - [Prerequisites](#prerequisites)
   - [Setup](#setup)
   - [Configuration](#configuration)
2. [API Overview](#api-overview)
3. [API Examples](#api-examples)
   - [Create a Record](#create-a-record)
   - [Retrieve Records](#retrieve-records)
   - [Search Records](#search-records)
   - [Update a Record](#update-a-record)
   - [Delete a Record](#delete-a-record)
   - [Batch Operations](#batch-operations)
4. [Using with LiekoDB Client](#using-with-liekodb-client)
5. [Troubleshooting](#troubleshooting)
6. [Contributing](#contributing)
7. [License](#license)

## Installation

### Prerequisites

- **Node.js**: Version 14 or higher.
- **npm**: Comes with Node.js.
- A directory for storing JSON data (e.g., `./data`).

### Setup

1. **Clone the Repository**

   ```bash
   git clone https://github.com/Eih3/liekoDB-core.git
   cd liekoDB-core
   ```

2. **Install Dependencies**

   ```bash
   npm install
   ```

   This installs required packages: `express`, `cors`, and `uuid`.

3. **Create Data Directory**

   Ensure a `./data` directory exists in the project root to store JSON files:

   ```bash
   mkdir data
   ```

4. **Generate a Project Token**

   The server uses token-based authentication. Generate a token (e.g., using UUID):

   ```bash
   node -e "console.log(require('uuid').v4())"
   ```

   Example output: `abc123e4-5678-9012-3456-7890abcdef12`

   Add the token to the `TOKENS` array in `index.js`:

   ```javascript
   const TOKENS = [
     {
       token: 'abc123e4-5678-9012-3456-7890abcdef12',
       projectId: 'proj1',
       permissions: 'full',
       collections: [{ name: 'users' }, { name: 'products' }]
     }
   ];
   ```

5. **Start the Server**

   ```bash
   node index.js
   ```

   The server runs on `http://localhost:6050` by default. Use the `PORT` environment variable to change the port:

   ```bash
   PORT=8080 node index.js
   ```

### Configuration

- **Port**: Set via `PORT` environment variable (default: 6050).
- **Data Directory**: Defaults to `./data`. Modify `DATA_DIR` in `index.js` if needed.
- **Tokens**: Configure tokens in the `TOKENS` array with appropriate permissions (`read`, `write`, `full`) and allowed collections.

## API Overview

The LiekoDB server exposes a RESTful API with the following key endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Check server health. |
| `GET` | `/api/ping` | Measure server latency. |
| `GET` | `/api/token/validate` | Validate a token. |
| `GET` | `/api/collections/:collection` | Retrieve records with optional filters, sorting, and pagination. |
| `GET` | `/api/collections/:collection/:id` | Retrieve a single record by ID. |
| `POST` | `/api/collections/:collection` | Create a new record. |
| `PUT` | `/api/collections/:collection/:id` | Update or create a record. |
| `DELETE` | `/api/collections/:collection/:id` | Delete a record. |
| `GET` | `/api/collections/:collection/search` | Search records by term. |
| `POST` | `/api/collections/:collection/batch-set` | Create or update multiple records. |
| `POST` | `/api/collections/:collection/batch-get` | Retrieve multiple records by ID. |
| `POST` | `/api/collections/:collection/batch-delete` | Delete multiple records. |
| `POST` | `/api/collections/:collection/batch-update` | Update multiple records. |
| `GET` | `/api/collections/:collection/count` | Count records matching a filter. |
| `GET` | `/api/collections/:collection/keys` | Get all record IDs. |
| `GET` | `/api/collections/:collection/entries` | Get all records as key-value pairs. |
| `GET` | `/api/collections/:collection/size` | Get the number of records. |
| `POST` | `/api/collections/:collection/:id/increment` | Increment a numeric field. |
| `POST` | `/api/collections/:collection/:id/decrement` | Decrement a numeric field. |

All endpoints require an `Authorization: Bearer <token>` header.

## API Examples

Include the token in all requests:

```bash
export TOKEN=abc123e4-5678-9012-3456-7890abcdef12
```

### Create a Record

**Request**:

```bash
curl -X POST http://localhost:6050/api/collections/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "user1", "name": "Bob Smith", "email": "bob@example.com"}'
```

**Response**:

```json
{
  "success": true,
  "data": {
    "id": "user1",
    "name": "Bob Smith",
    "email": "bob@example.com"
  }
}
```

### Retrieve Records

**Request**: Get all users with a filter and pagination.

```bash
curl -X GET "http://localhost:6050/api/collections/users?filter=%7B%22%24eq%22:%7B%22status%22:%22active%22%7D%7D&limit=10&offset=0&sort=name" \
  -H "Authorization: Bearer $TOKEN"
```

**Response**:

```json
{
  "success": true,
  "data": [
    {
      "id": "user1",
      "name": "Bob Smith",
      "email": "bob@example.com",
      "status": "active"
    }
  ],
  "totalCount": 1,
  "actualPage": 1,
  "maxPage": 1
}
```

### Search Records

**Request**: Search for users containing "bob" in any field.

```bash
curl -X GET "http://localhost:6050/api/collections/users/search?term=bob" \
  -H "Authorization: Bearer $TOKEN"
```

**Response**:

```json
{
  "success": true,
  "data": [
    {
      "id": "user1",
      "name": "Bob Smith",
      "email": "bob@example.com"
    },
    {
      "id": "user2",
      "name": "Alice Bobson",
      "email": "alice@example.com"
    }
  ],
  "totalCount": 2,
  "actualPage": 1,
  "maxPage": 1
}
```

**Request**: Search in specific fields.

```bash
curl -X GET "http://localhost:6050/api/collections/users/search?term=bob&fields=name,email" \
  -H "Authorization: Bearer $TOKEN"
```

### Update a Record

**Request**:

```bash
curl -X PUT http://localhost:6050/api/collections/users/user1 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Bob Updated", "status": "active"}'
```

**Response**:

```json
{
  "success": true,
  "data": {
    "id": "user1",
    "name": "Bob Updated",
    "email": "bob@example.com",
    "status": "active"
  }
}
```

### Delete a Record

**Request**:

```bash
curl -X DELETE http://localhost:6050/api/collections/users/user1 \
  -H "Authorization: Bearer $TOKEN"
```

**Response**:

```json
{
  "success": true,
  "data": true
}
```

### Batch Operations

**Request**: Batch create users.

```bash
curl -X POST http://localhost:6050/api/collections/users/batch-set \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"records": [{"id": "user1", "name": "Bob"}, {"id": "user2", "name": "Alice"}]}'
```

**Response**:

```json
{
  "success": true,
  "results": [
    {
      "id": "user1",
      "status": "success",
      "record": { "id": "user1", "name": "Bob" }
    },
    {
      "id": "user2",
      "status": "success",
      "record": { "id": "user2", "name": "Alice" }
    }
  ],
  "total": 2,
  "errors": []
}
```

## Using with LiekoDB Client

The LiekoDB server pairs with the [LiekoDB JavaScript Client](https://github.com/your-repo/liekoDB-client) for a seamless experience. The client simplifies API calls with methods like `get`, `set`, `search`, and `batchSet`.

**Example**:

```javascript
const liekoDB = require('liekoDB');

const db = new liekoDB({
  token: 'abc123e4-5678-9012-3456-7890abcdef12',
  debug: true
});

async function main() {
  // Create a user
  await db.set('users', 'user1', { name: 'Bob', email: 'bob@example.com' });

  // Search for "bob"
  const users = await db.get('users', { filter: { $search: 'bob' } });
  console.log(users.data);

  // Paginate users
  const page = await db.paginate('users', 1, 10);
  console.log(page.data);
}

main().catch(console.error);
```

See the [LiekoDB Client Documentation](https://github.com/your-repo/liekoDB-client) for full details.

## Troubleshooting

- **401 Unauthorized**: Ensure the `Authorization: Bearer <token>` header is correct and the token is in `TOKENS`.
- **404 Not Found**: Verify the collection or record exists. Create collections automatically by adding records.
- **500 Server Error**: Check server logs (`node index.js`) and ensure the `./data` directory is writable.
- **Empty Search Results**: Confirm the search term matches field values (case-insensitive). Specify `fields` if needed.
- **Connection Issues**: Ensure the server is running and the port matches the client’s `databaseUrl`.

## Contributing

We welcome contributions! To contribute:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/my-feature`).
3. Commit changes (`git commit -m 'Add my feature'`).
4. Push to the branch (`git push origin feature/my-feature`).
5. Open a Pull Request.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) and include tests for new features.

## License

MIT License

Copyright (c) 2025 Your Name

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
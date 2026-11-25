# Online Bookstore

## Structure

```
bookstore project/
├── client/   React 19 + Carbon + React Router (Vite)
└── server/   Node.js + Express + Mongoose + MongoDB
```

## Setup

### Server
```
cd server
cp .env.example .env        # set MONGODB_URI
npm install
npm run db:seed             # optional sample data
npm run dev                 # http://127.0.0.1:4000
```

### Client
```
cd client
npm install
npm run dev                 # http://127.0.0.1:5173 (proxies /api to the server)
```

Run `npm outdated` in each package and upgrade to the latest stable versions before starting development.

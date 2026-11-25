import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { csrfProtection } from './middleware/csrf.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: env.API_RATE_LIMIT }));
app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));

app.use('/api', csrfProtection, routes);

app.use(notFound);
app.use(errorHandler);

export default app;

import express, {
  type Application,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from 'express';

export interface CreateHttpAppOptions {
  publicUrl: string;
  oauthRouter: Router;
  bearer: RequestHandler;
  health: () => Promise<object> | object;
  mcp?: RequestHandler;
  actions?: Router;
}

const notImplemented: RequestHandler = (_req, res) => {
  res.status(501).json({ error: 'not_implemented' });
};

/** Builds the Claudia HTTP app: /health, the OAuth endpoints, and the bearer-guarded /mcp route. */
export function createHttpApp(opts: CreateHttpAppOptions): Application {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => opts.health())
      .then((body) => res.json(body))
      .catch(next);
  });

  app.use(opts.oauthRouter);

  app.all('/mcp', opts.bearer, opts.mcp ?? notImplemented);

  if (opts.actions) {
    app.use('/a', opts.actions);
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Error handler: four-argument signature is required by Express to be recognized as one.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled HTTP error:', err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}

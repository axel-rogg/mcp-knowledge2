// AS-3 K3/K4: OAuth-facade root router.
//
// Composes the per-endpoint routers (discovery, DCR, authorize, callback, token).

import { Hono } from 'hono';
import { discoveryRouter } from './discovery.ts';
import { dcrRouter } from './dcr.ts';

export const oauthFacadeRouter = new Hono();
oauthFacadeRouter.route('/', discoveryRouter);
oauthFacadeRouter.route('/', dcrRouter);
// K4: authorize + callback + token routers will be mounted here.

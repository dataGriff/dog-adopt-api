import { Hono } from 'hono';
import type { Breed } from '@dogadopt/contracts';
import type { Env } from '../env.js';
import { Repo } from '../repo.js';

export const breeds = new Hono<{ Bindings: Env }>();

breeds.get('/v1/breeds', async (c) => {
  const items: Breed[] = await new Repo(c.env.DB).listBreeds();
  return c.json({ items });
});

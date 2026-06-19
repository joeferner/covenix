import { describe, expect, it } from 'vitest';
import SwaggerParser from '@apidevtools/swagger-parser';
import { z } from 'zod';
import { Body, Get, Params, Post, Query, Returns, Route, Summary, Tags } from './decorators.js';
import { generateSwagger } from './swagger.js';

const User = z.object({ id: z.string(), name: z.string() }).meta({ id: 'User' });
const CreateUser = z.object({ name: z.string().min(1) }).meta({ id: 'CreateUser' });

@Route('users')
@Tags('Users')
class UsersController {
  @Get('{id}')
  @Summary('Get a user')
  @Params(z.object({ id: z.string() }))
  @Query(z.object({ verbose: z.coerce.boolean().optional() }))
  @Returns(200, User)
  public get(): unknown {
    return null;
  }

  @Post()
  @Summary('Create a user')
  @Body(CreateUser)
  @Returns(201, User)
  public create(): unknown {
    return null;
  }
}

const info = { title: 'My API', version: '1.0.0' };

describe('swagger accuracy', () => {
  it('produces a document that passes OpenAPI validation', async () => {
    const doc = generateSwagger([UsersController], info);
    // validate() dereferences in place, so hand it a clone.
    await expect(SwaggerParser.validate(structuredClone(doc))).resolves.toBeDefined();
  });

  it('matches the snapshot', () => {
    const doc = generateSwagger([UsersController], info);
    expect(doc).toMatchSnapshot();
  });
});

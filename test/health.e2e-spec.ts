import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('health (e2e)',()=>{
  let app:INestApplication;
  beforeAll(async()=>{
    const moduleRef=await Test.createTestingModule({imports:[AppModule]}).compile();
    app=moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    await app.init();
  });
  afterAll(()=>app.close());
  it('/v1/health/live',()=>request(app.getHttpServer()).get('/v1/health/live').expect(200));
});

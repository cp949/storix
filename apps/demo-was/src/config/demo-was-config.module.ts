import { Global, Module } from '@nestjs/common';
import { DEMO_WAS_CONFIG, loadDemoWasConfig } from './demo-was-config.js';

@Global()
@Module({
  providers: [{ provide: DEMO_WAS_CONFIG, useFactory: loadDemoWasConfig }],
  exports: [DEMO_WAS_CONFIG],
})
export class DemoWasConfigModule {}

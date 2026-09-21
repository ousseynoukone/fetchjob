import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { AutoApplyService } from './src/auto-apply/auto-apply.service';

async function runTest() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const applyService = app.get(AutoApplyService);
  console.log("Running direct process on Swood Partners...");
  try {
    await applyService.run({
      userId: 'cmtf5evc60000hdw4mc8xrgkv',
      applicationIds: ['cmu9x5sx400knel313wd9c4xe'],
      atsEnabled: true,
      minDelaySeconds: 0,
      maxDelaySeconds: 0,
      appendLog: async (m) => console.log(m)
    });
    console.log("Process complete!");
  } catch(e) {
    console.error(e);
  }
  await app.close();
}
runTest();

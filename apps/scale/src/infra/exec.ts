import { spawn, spawnSync } from 'node:child_process';

/** 명령을 실행하고 stdout을 돌려준다. 실패하면 stderr를 담아 던진다. */
export function run(command: string, args: readonly string[], input?: string): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf-8',
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} 실패(exit ${result.status}):\n${result.stderr}`);
  return result.stdout;
}

/** 입력을 stdin으로 흘려 보내며 비동기로 실행한다. 큰 SQL을 메모리에 모으지 않고 전달할 때 쓴다. */
export function runAsync(command: string, args: readonly string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(' ')} 실패(exit ${code}):\n${stderr.slice(-4000)}`));
    });
    child.stdin.end(input);
  });
}

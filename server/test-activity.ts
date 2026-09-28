import { AppError } from './errors.js';

/** Bandwidth measurements and compatibility probes share the same machine. */
export class TestActivity {
  private owner: string | null = null;
  acquire(owner: string) {
    if (this.owner)
      throw new AppError('TEST_BUSY', '已有测试批次正在运行，请查看测试中心或取消后重试。', 409);
    this.owner = owner;
    return () => {
      if (this.owner === owner) this.owner = null;
    };
  }
  current() {
    return this.owner;
  }
}

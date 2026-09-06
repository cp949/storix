import 'reflect-metadata';
import { IS_PUBLIC_KEY, Public } from './public.decorator.js';

describe('Public', () => {
  it('클래스에 적용하면 IS_PUBLIC_KEY 메타데이터를 true로 설정한다', () => {
    @Public()
    class TestController {}

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, TestController)).toBe(true);
  });

  it('메서드에 적용하면 해당 메서드에 IS_PUBLIC_KEY 메타데이터를 true로 설정한다', () => {
    class TestController {
      @Public()
      handler() {}
    }

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, TestController.prototype.handler)).toBe(true);
  });
});

# Namespace는 불변 id와 재사용 가능한 name을 분리한다

- VFS API는 Namespace를 불변 `id`로만 참조한다.
- 이 결정에서는 UUID 형식을 사용한다.
- 이후 ID 형식 확장과 nullable `name`은 api ADR-0036에서 결정한다.
- 사람이 정하는 `name`(slug)은 API 식별자로 쓰지 않는다.
- Namespace를 삭제하면 다른 Namespace가 같은 `name`을 즉시 재사용할 수 있다.

## 결정 근거

- `name`을 식별자로 쓰면 삭제 후 이름 충돌과 기존 참조 무효화를 별도로 처리해야 한다.
- `id`로 참조하면 이름 재사용이 기존 참조에 영향을 주지 않는다.

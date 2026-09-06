# Namespace는 불변 id와 재사용 가능한 name을 분리한다

VFS API는 Namespace를 불변 UUID `id`로만 참조하고, 사람이 정하는 `name`(slug)은 API
식별자로 쓰지 않는다. Namespace를 삭제한 직후 같은 `name`을 다른 Namespace가 바로
다시 쓸 수 있어야 하는데, `name`이 식별자였다면 삭제 직후의 이름 충돌과 기존 참조
무효화 문제를 별도로 풀어야 했다. `id` 기반 참조로 이 문제를 원천적으로 피한다.

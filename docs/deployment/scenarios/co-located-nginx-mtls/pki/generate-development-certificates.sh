#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_dir=${1:-"${script_dir}/generated"}

if [ -e "$output_dir" ]; then
  echo "출력 경로가 이미 존재함: $output_dir" >&2
  echo "기존 인증서를 보존하기 위해 덮어쓰지 않음" >&2
  exit 1
fi

umask 077
mkdir -p "$output_dir"

cleanup() {
  rm -f "$output_dir/server.csr" "$output_dir/was-client.csr" \
    "$output_dir/server.ext" "$output_dir/was-client.ext" "$output_dir/ca.srl"
}
trap cleanup EXIT HUP INT TERM

openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
  -subj '/CN=Storix Development CA' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$output_dir/ca.key" \
  -out "$output_dir/ca.crt"

openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -subj '/CN=storix.internal' \
  -keyout "$output_dir/server.key" \
  -out "$output_dir/server.csr"

printf '%s\n' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' \
  'subjectAltName=DNS:storix.internal' \
  > "$output_dir/server.ext"

openssl x509 -req -sha256 -days 825 \
  -in "$output_dir/server.csr" \
  -CA "$output_dir/ca.crt" \
  -CAkey "$output_dir/ca.key" \
  -CAcreateserial \
  -extfile "$output_dir/server.ext" \
  -out "$output_dir/server.crt"

openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -subj '/CN=storix-development-was' \
  -keyout "$output_dir/was-client.key" \
  -out "$output_dir/was-client.csr"

printf '%s\n' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature' \
  'extendedKeyUsage=clientAuth' \
  > "$output_dir/was-client.ext"

openssl x509 -req -sha256 -days 825 \
  -in "$output_dir/was-client.csr" \
  -CA "$output_dir/ca.crt" \
  -CAkey "$output_dir/ca.key" \
  -CAcreateserial \
  -extfile "$output_dir/was-client.ext" \
  -out "$output_dir/was-client.crt"

openssl verify -CAfile "$output_dir/ca.crt" \
  "$output_dir/server.crt" "$output_dir/was-client.crt"

chmod 600 "$output_dir/ca.key" "$output_dir/server.key" "$output_dir/was-client.key"
chmod 644 "$output_dir/ca.crt" "$output_dir/server.crt" "$output_dir/was-client.crt"

echo "개발용 인증서 생성 완료: $output_dir"

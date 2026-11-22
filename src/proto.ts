import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

// src/proto.ts runs from the checkout, dist/src/proto.js from a build: the
// proto directory is one or two levels up.
export const PROTO_PATH = ['../proto/tapis.proto', '../../proto/tapis.proto']
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  .find((p) => existsSync(p)) as string;
if (!PROTO_PATH) throw new Error('tapis.proto not found next to the tapis package');

export function loadTapis(): grpc.GrpcObject {
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return (grpc.loadPackageDefinition(def).tapis as grpc.GrpcObject).v1 as grpc.GrpcObject;
}

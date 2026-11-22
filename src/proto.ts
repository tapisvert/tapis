import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const PROTO_PATH = fileURLToPath(new URL('../proto/tapis.proto', import.meta.url));

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

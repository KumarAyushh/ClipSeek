// Public entry point of @app/shared. Apps import from here:
//   import { config, sql, createKafka } from "@app/shared";
// The model loaders have their own entry, "@app/shared/models" (see models.ts for why).
export { config } from "./config";
export { sql } from "./db";
export { createKafka, createProducer, KafkaJSError, VIDEO_UPLOADED_PARTITIONS } from "./kafka";
export type { Consumer } from "./kafka";
export type { Video, VideoStatus, VideoUploadedEvent } from "./types";
// Only a type import of transformers.js inside, so this stays light for the main entry.
export { l2normalize, toPgVector, toVectors } from "./vectors";

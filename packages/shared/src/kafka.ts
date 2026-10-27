// Helper to create a Kafka client with the shared broker settings.
// The API uses it to create a producer; each worker uses it to create a consumer.

import { Kafka, logLevel } from "kafkajs";
import { config } from "./config";

// The video.uploaded topic is split into 3 partitions. Inside one consumer group,
// each partition is read by only one consumer, so 3 partitions allow up to 3 copies
// of the same worker to process 3 different videos at the same time.
export const VIDEO_UPLOADED_PARTITIONS = 3;

// clientId is just a label (e.g. "api", "visual-worker") that shows up in Kafka logs,
// so you can tell which app a connection belongs to.
export function createKafka(clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: config.kafka.brokers,
    logLevel: logLevel.WARN, // hide kafkajs's chatty INFO logs; still show warnings and errors
  });
}

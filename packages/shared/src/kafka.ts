// Helper to create a Kafka client with the shared broker settings.
// The API uses it to create a producer; each worker uses it to create a consumer.

import { Kafka, logLevel, Partitioners, type Producer } from "kafkajs";
import { config } from "./config";

// Base class of every kafkajs error. Workers use it to tell "Kafka had a problem"
// (e.g. a rebalance while we were working) apart from "this video couldn't be processed".
// Re-exported here so apps don't need kafkajs as their own dependency.
export { KafkaJSError } from "kafkajs";
export type { Consumer } from "kafkajs";

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

// A producer sends messages to a topic. Only the API produces (after an upload).
export function createProducer(clientId: string): Producer {
  return createKafka(clientId).producer({
    // Picks the partition as hash(key) % partitions (same formula as Java Kafka clients),
    // so every message with the same videoId goes to the same partition.
    // kafkajs v2 already uses it by default; naming it explicitly silences its startup warning.
    createPartitioner: Partitioners.DefaultPartitioner,
    // The topic must already exist (scripts/create-topics.ts). Never create one by accident.
    allowAutoTopicCreation: false,
  });
}

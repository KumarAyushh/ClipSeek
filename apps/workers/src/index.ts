// Entry point for the background workers.
// Day 4 turns this into three Kafka consumers, each in its own consumer group:
//   visual-worker  -> frames   (CLIP)
//   speech-worker  -> segments (Whisper + bge-small)
//   sound-worker   -> sounds   (CLAP)
// For now it only loads the config, which proves the env vars are set correctly.

import { config } from "@app/shared";

console.log(`workers: ready to connect to Kafka at ${config.kafka.brokers.join(",")}`);
console.log(`workers: will consume topic "${config.kafka.topicVideoUploaded}" (consumers added on Day 4)`);

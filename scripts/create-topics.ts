// Creates the Kafka topic `video.uploaded` with 3 partitions (safe to run again).
// Usage: bun run kafka:setup
//
// Auto-create is turned off in docker-compose.yml, so this script is the only way
// the topic gets made. That way the partition count is always what we chose.

import { config, createKafka, VIDEO_UPLOADED_PARTITIONS } from "@app/shared";

const topic = config.kafka.topicVideoUploaded;

async function main() {
  // The admin client manages topics. It doesn't send or read messages.
  const admin = createKafka("setup-script").admin();
  await admin.connect();

  try {
    const existing = await admin.listTopics();

    if (existing.includes(topic)) {
      console.log(`topic "${topic}" already exists`);
    } else {
      await admin.createTopics({
        waitForLeaders: true, // wait until every partition is ready to accept messages
        topics: [
          {
            topic,
            numPartitions: VIDEO_UPLOADED_PARTITIONS,
            replicationFactor: 1, // only one broker, so only one copy of each partition
          },
        ],
      });
      console.log(`created topic "${topic}"`);
    }

    // Read the topic back from Kafka to show the real partition count
    const { topics } = await admin.fetchTopicMetadata({ topics: [topic] });
    const partitions = topics[0]?.partitions.length ?? 0;
    console.log(`"${topic}" has ${partitions} partition(s)`);

    if (partitions !== VIDEO_UPLOADED_PARTITIONS) {
      throw new Error(`expected ${VIDEO_UPLOADED_PARTITIONS} partitions, found ${partitions}`);
    }
  } finally {
    await admin.disconnect();
  }
}

main().catch((err) => {
  console.error("kafka setup failed:", err);
  process.exitCode = 1;
});

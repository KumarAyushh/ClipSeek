// The API's one Kafka producer. It connects once at startup (see index.ts) and is
// reused for every upload. Opening a new connection per upload would be slow.

import { config, createProducer, type VideoUploadedEvent } from "@app/shared";

export const producer = createProducer("api");

// Tell the workers a new video is ready to process.
// key = videoId → Kafka hashes it to pick one of the 3 partitions (always the same one for this video).
// value = JSON body the workers parse back into a VideoUploadedEvent.
// send() resolves only after the broker has stored the message (acks from all replicas,
// which with our single broker means "written to disk on that one broker").
export async function publishVideoUploaded(event: VideoUploadedEvent): Promise<void> {
  await producer.send({
    topic: config.kafka.topicVideoUploaded,
    messages: [{ key: event.videoId, value: JSON.stringify(event) }],
  });
}

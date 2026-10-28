// Loads the ML models the workers use. Each loader is called ONCE per process, at startup,
// and the loaded model is reused for every video (loading takes seconds; running is fast).
// Day 6 adds Whisper + bge here, Day 7 adds CLAP. (Day 8 moves the loaders to
// packages/shared, because the API needs the text encoders for search.)

import path from "node:path";
import { config } from "@app/shared";
import { AutoProcessor, CLIPVisionModelWithProjection, env } from "@huggingface/transformers";

// Keep downloaded models in storage/models instead of deep inside node_modules,
// so `bun install` never wipes them and they stay out of git (storage/ is ignored).
env.cacheDir = path.join(config.storageDir, "models");

// Full-precision weights (the CPU default, written out so it's visible). See Decisions log.
const DTYPE = "fp32";

// CLIP's IMAGE side, for frames. Search (Day 8) will use CLIP's TEXT side with the same
// model id, so frames and queries land in the same 512-d space.
// - processor: resizes the shorter side to 224, center-crops 224x224, normalizes pixels
// - model: "WithProjection" = returns `image_embeds` from the projection head (512-d),
//   the layer that is shared with the text side
export async function loadClipVision() {
  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(config.models.clip),
    CLIPVisionModelWithProjection.from_pretrained(config.models.clip, { dtype: DTYPE }),
  ]);
  return { processor, model };
}

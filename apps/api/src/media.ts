// ffmpeg / ffprobe helpers used by the upload route.
// Both tools are run with an argument array (Bun.spawn), never a shell string,
// so a strange file name can't be read as an extra command.

// Run a command, wait for it to finish, and return what it printed to stdout.
// Throws with ffmpeg's own error text if it exits with a non-zero code.
async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  // Read both outputs while the process runs, so a full pipe can't make it hang.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd[0]} failed: ${stderr.trim()}`);
  }
  return stdout;
}

// Copy `input` to `output` with the mp4 index (the "moov" atom) moved to the start.
// - `-c copy`: copy the audio/video streams as they are, no re-encoding, so it's fast
//   (a few seconds even for a big file) and the quality doesn't change.
// - `-movflags +faststart`: write the moov atom first. A browser needs it before it can
//   play or seek, so with it at the front playback starts right away.
// - `-map 0:v:0 -map 0:a:0?`: keep only the first video track and the first audio track (`?` =
//   fine if there's none). Subtitle or data tracks (common in mkv files and phone videos) can
//   make an mp4 output fail, and nothing here uses them.
// - `-nostdin`: ffmpeg must never wait for keyboard input inside a server.
// - `-y`: overwrite `output` if it already exists.
export async function faststart(input: string, output: string): Promise<void> {
  await run([
    "ffmpeg", "-nostdin", "-v", "error", "-y",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c", "copy",
    "-movflags", "+faststart",
    output,
  ]);
}

// What ffprobe prints with -show_format -show_streams. We store the whole object in
// videos.metadata (jsonb) and only type the few fields our code actually reads.
export type ProbeResult = {
  format: { duration?: string; [key: string]: unknown };
  streams: { codec_type?: string; [key: string]: unknown }[];
};

// Read every piece of metadata ffprobe can find: container info (`format`: duration,
// size, bitrate) and one entry per stream (`streams`: codec, resolution, fps, sample rate).
export async function probe(file: string): Promise<ProbeResult> {
  const json = await run([
    "ffprobe", "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    file,
  ]);
  return JSON.parse(json) as ProbeResult;
}

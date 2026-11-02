const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
  {
    type: "input",
    field: "baseUrl" as const,
    title: "请求地址",
    value: "https://grsai.dakka.com.cn",
    props: { placeholder: "https://grsai.dakka.com.cn 或 https://grsaiapi.com" },
  },
] as const;

const version = "1.0.0";

type ReferencedVideoRequest = VideoRequest & {
  referenceOrder?: ({ type: "image" | "video" | "audio"; index: number } | { type: "firstFrame" | "lastFrame" | "text" })[];
};

function videoPrompt(request: ReferencedVideoRequest) {
  return request.prompt.replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => {
    const reference = request.referenceOrder?.[Number(number) - 1];
    if (!reference) throw new Error(`引用标记 ${marker} 缺少素材映射，请更新视频节点或提供 referenceOrder`);
    if (reference.type === "text") return `参考 ${Number(number)}`;
    if (reference.type === "firstFrame" || reference.type === "lastFrame") {
      if (!request[reference.type]) throw new Error(`引用标记 ${marker} 对应的首尾帧未提交`);
      return reference.type === "firstFrame" ? "图片1" : "图片2";
    }
    if (!("index" in reference)) throw new Error(`引用标记 ${marker} 的素材类型无效`);
    const media = { image: request.images, video: request.videos, audio: request.audios };
    if (!Number.isSafeInteger(reference.index) || reference.index < 0 || !media[reference.type]?.[reference.index]) {
      throw new Error(`引用标记 ${marker} 对应的素材未提交，请重新选择引用`);
    }
    const labels = { image: "图片", video: "视频", audio: "音频" };
    return `${labels[reference.type]}${reference.index + 1}`;
  });
}

function mediaUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function aspectRatio(ratio: string | undefined) {
  const value = (ratio ?? "9:16").trim();
  const [width, height] = value.split(":").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width === height) {
    throw new Error("Grsai 只支持横屏或竖屏，请使用 16:9、4:3、9:16 或 3:4");
  }
  return height > width ? "portrait" : "landscape";
}

function resolutionOf(value: string | undefined) {
  const text = (value ?? "768p").trim().toLowerCase();
  if (text === "480p" || text === "768p" || text === "1080p") return text;
  throw new Error("Grsai 的分辨率只支持 480p、768p、1080p");
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

type GrsaiTask = { id?: string; status?: string; results?: { url?: string }[]; error?: string };

function videoUrl(data: GrsaiTask) {
  const url = data.results?.find(item => typeof item.url === "string" && item.url)?.url;
  if (!url) throw new Error("视频生成成功但未返回视频地址");
  return url;
}

async function readTask(response: Response): Promise<GrsaiTask> {
  if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
  const text = (await response.text()).trim();
  const json = text.startsWith("data:") ? text.slice(5).trim() : text;
  return JSON.parse(json) as GrsaiTask;
}

async function pollVideo(context: ProviderContext, baseUrl: string, apiKey: string, taskId: string, signal: AbortSignal): Promise<string> {
  while (true) {
    const data = await readTask(await context.tool.fetch(`${baseUrl}/v1/api/result?id=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    }));
    const status = data.status;
    if (status === "succeeded") return videoUrl(data);
    if (status === "failed" || status === "violation") {
      throw Object.assign(new Error(context.tool.errorMessage?.(data) || data.error || "视频生成失败"), { code: "MEDIA_TASK_FAILED" });
    }
    await wait(signal, 5000);
  }
}

export default {
  id: "grsai",
  label: "Grsai",
  icon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#111"/><text x="16" y="22" text-anchor="middle" font-size="16" fill="#fff" font-family="sans-serif">G</text></svg>')}`,
  version,
  readme: `Grsai 的 MiniMax-H3 视频接口。国内节点 https://grsai.dakka.com.cn ，全球节点 https://grsaiapi.com 。
密钥见 [Grsai API Keys](https://grsai.ai/zh/dashboard/api-keys)。`,
  rules,
  models: [
    {
      id: "minimax-h3",
      label: "MiniMax-H3",
      type: "video",
      mode: ["text", "singleImage", ["imageReference:9", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "768p", "1080p"] }],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: ReferencedVideoRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    const baseUrl = (this.config.baseUrl?.trim() || "https://grsai.dakka.com.cn").replace(/\/$/, "");
    const images = [...(request.images ?? []), ...(request.firstFrame ? [request.firstFrame] : []), ...(request.lastFrame ? [request.lastFrame] : [])];
    const audios = request.audios ?? [];
    if ((request.videos ?? []).length) throw new Error("Grsai 的 MiniMax-H3 暂不支持参考视频");
    if (images.length > 9) throw new Error("Grsai 最多支持 9 张参考图");
    if (audios.length > 3) throw new Error("Grsai 最多支持 3 段参考音频");
    const resolution = resolutionOf(request.resolution);
    const duration = Math.round(request.duration ?? 5);
    if (duration < 1 || duration > 15) throw new Error("Grsai 的视频时长需要在 1 到 15 秒之间");
    if (resolution === "1080p" && duration > 10) throw new Error("Grsai 的 1080p 视频时长不能超过 10 秒");

    // 公开文档字段为 camelCase（prompt/images/audios/resolution/duration/promptSkill），没有单独的音频开关。
    // 节点开关按同名 generateAudio 转发，避免被丢掉；不传时保持上游默认原生音轨。
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: videoPrompt({ ...request, images, audios }),
      aspectRatio: aspectRatio(request.ratio),
      images: images.map(mediaUrl),
      audios: audios.map(mediaUrl),
      resolution,
      duration,
      promptSkill: true,
      replyType: "async",
    };
    if (typeof request.generateAudio === "boolean") body.generateAudio = request.generateAudio;

    // ACT: 单次生成最多等待 30 分钟。
    const deadline = Date.now() + 30 * 60_000;
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const submitResponse = await this.tool.fetch(`${baseUrl}/v1/api/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!submitResponse.ok) throw new Error(`提交任务失败：HTTP ${submitResponse.status}`);
    const submitData = await readTask(submitResponse);
    if (submitData.status === "failed" || submitData.status === "violation") {
      throw Object.assign(new Error(this.tool.errorMessage?.(submitData) || submitData.error || "视频生成失败"), { code: "MEDIA_TASK_FAILED" });
    }
    if (submitData.status === "succeeded") return [{ mediaType: "video", type: "url", url: videoUrl(submitData) }];
    const taskId = submitData.id;
    if (typeof taskId !== "string" || !taskId) throw new Error("提交任务未返回任务 ID");
    await this.saveTaskData?.({ kind: "grsaiVideo", taskId, model: request.model, baseUrlHash: String(this.tool.hash(baseUrl)), deadline });
    return [{ mediaType: "video", type: "url", url: await pollVideo(this, baseUrl, apiKey, taskId, signal) }];
  },
  async resumeTask(data: ProviderTaskData): Promise<MediaAsset[]> {
    const baseUrl = (this.config.baseUrl?.trim() || "https://grsai.dakka.com.cn").replace(/\/$/, "");
    if (data.kind !== "grsaiVideo" || typeof data.taskId !== "string" || !data.taskId || typeof data.model !== "string"
      || data.baseUrlHash !== String(this.tool.hash(baseUrl)) || typeof data.deadline !== "number" || !Number.isFinite(data.deadline)) {
      throw new Error("视频任务恢复数据无效或请求地址已变更");
    }
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    return [{ mediaType: "video", type: "url", url: await pollVideo(this, baseUrl, apiKey, data.taskId, signal) }];
  },
} satisfies ProviderDefinition<typeof rules>;

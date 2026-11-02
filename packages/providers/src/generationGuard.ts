export type GenerationReference = {
  dataType?: string | string[];
  value?: unknown;
};

function isImageReference(reference: GenerationReference | undefined) {
  if (!reference?.value) return false;
  return reference.dataType === "IMAGE" || (Array.isArray(reference.dataType) && reference.dataType.includes("IMAGE"));
}

const burnedSubtitlePatterns = [
  /画面(?:底部|下方|中|上|里).{0,12}字幕/g,
  /底部字幕/g,
  /字幕(?:同时)?出现/g,
  /同时出现.{0,12}字幕/g,
  /出现完整字幕/g,
  /烧录字幕|烧入字幕|烧字/g,
  /burn(?:ed)?[-\s]?in\s+(?:captions?|subtitles?)/gi,
  /on[-\s]?screen\s+(?:captions?|subtitles?)/gi,
  /(?:captions?|subtitles?)\s+(?:appear|burned)/gi,
];

const identityNeed = /定妆图|定妆参考|参考定妆|依据定妆|按定妆|使用定妆|身份参考|角色参考图|锁定身份|锁定形象|保持[^。\n]{0,8}形象|character\s+reference\s+image|identity\s+reference|identity\s+lock/i;
const identityRefLine = /身份|定妆|角色参考|character\s+reference|identity/i;

function negated(prompt: string, index: number) {
  return /(?:无|没有|不要|不出现|不生成|禁止|勿|别|无需|不含|no\b|without|do not|don't|never)/i.test(prompt.slice(Math.max(0, index - 12), index));
}

function lineAt(prompt: string, index: number) {
  const start = prompt.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const end = prompt.indexOf("\n", index);
  return prompt.slice(start, end === -1 ? undefined : end);
}

function burnedSubtitle(prompt: string) {
  for (const pattern of burnedSubtitlePatterns) {
    pattern.lastIndex = 0;
    for (const match of prompt.matchAll(pattern)) {
      if (!negated(prompt, match.index ?? 0)) return match[0];
    }
  }
}

/** 生图/生视频提交前的硬校验。references 按 {{ref N}} 的入边顺序传入。 */
export function assertGenerationGuard(prompt: string, input: { references?: GenerationReference[]; imageCount?: number } = {}) {
  const burned = burnedSubtitle(prompt);
  if (burned) {
    throw new Error(`提示词要求把字幕画进画面（${burned}）。请删掉烧录字幕的描述，字幕在后期添加；可以保留「无字幕」。`);
  }
  const references = input.references;
  const imageCount = references
    ? references.filter(item => isImageReference(item)).length
    : input.imageCount ?? 0;
  const identityPattern = new RegExp(identityNeed.source, "gi");
  const identityHit = [...prompt.matchAll(identityPattern)].find(match => !negated(prompt, match.index ?? 0));
  if (identityHit && imageCount === 0) {
    throw new Error("提示词要求使用角色定妆或身份参考图，但没有接入可用的图片。请先连接定妆图片节点。");
  }
  if (!references) return;
  for (const match of prompt.matchAll(/\{\{ref\s+(\d+)\}\}/g)) {
    if (!identityRefLine.test(lineAt(prompt, match.index ?? 0))) continue;
    const reference = references[Number(match[1]) - 1];
    if (isImageReference(reference)) continue;
    throw new Error(`{{ref ${match[1]}}} 被写成角色身份，但对应入边不是可用图片。请按引用顺序连接定妆图。`);
  }
}

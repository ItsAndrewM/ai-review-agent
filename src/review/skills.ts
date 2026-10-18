import type {
  SkillContent,
  SkillDescriptor,
  SkillManifest,
  SkillManifestEntry,
  SkillResource,
  SkillResourceDescriptor,
  SkillSource,
} from "agents/skills"
import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import { parse } from "yaml"

export interface SkillFile {
  readonly path: string
  readonly content: string
}

const Frontmatter = Type.Object({
  name: Type.String({ pattern: "\\S" }),
  description: Type.String({ pattern: "\\S" }),
  metadata: Type.Optional(Type.Object({ version: Type.Optional(Type.Union([Type.String(), Type.Number()])) })),
})

interface ParsedSkillFile {
  readonly frontmatter: Static<typeof Frontmatter>
  readonly body: string
}

type Attribute = readonly [name: string, value: string | undefined]

const SKILL_FILE = "SKILL.md"
const REFERENCES_PREFIX = "references/"
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const utf8 = new TextEncoder()

const byPath = (a: SkillFile, b: SkillFile): number => {
  if (a.path < b.path) return -1
  return a.path > b.path ? 1 : 0
}

const sortedByPath = (files: readonly SkillFile[]): SkillFile[] => [...files].sort(byPath)

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

export async function fingerprintOf(files: readonly SkillFile[]): Promise<string> {
  const material = sortedByPath(files)
    .map(({ path, content }) => `${path}\n${content}\n`)
    .join("")
  return toHex(await crypto.subtle.digest("SHA-256", utf8.encode(material)))
}

const groupByDirectory = (files: readonly SkillFile[]): Map<string, SkillFile[]> => {
  const groups = new Map<string, SkillFile[]>()
  for (const { path, content } of files) {
    const separator = path.indexOf("/")
    if (separator === -1) continue
    const directory = path.slice(0, separator)
    const members = groups.get(directory) ?? []
    members.push({ path: path.slice(separator + 1), content })
    groups.set(directory, members)
  }
  return groups
}

const resourceOf = ({ path, content }: SkillFile): SkillResource => ({
  path,
  kind: path.startsWith(REFERENCES_PREFIX) ? "reference" : "file",
  encoding: "text",
  size: utf8.encode(content).length,
  content,
})

const parseSkillFile = (directory: string, raw: string): ParsedSkillFile => {
  const invalid = `skills/${directory}/${SKILL_FILE}: invalid frontmatter`
  const match = FRONTMATTER_BLOCK.exec(raw)
  if (!match) throw new Error(invalid)
  const [, yamlText = "", body = ""] = match
  let data: unknown
  try {
    data = parse(yamlText)
  } catch (cause) {
    throw new Error(invalid, { cause })
  }
  if (!Value.Check(Frontmatter, data)) throw new Error(invalid)
  return { frontmatter: data, body }
}

const entryOf = (directory: string, skillFile: SkillFile, others: readonly SkillFile[]): SkillManifestEntry => {
  const { frontmatter, body } = parseSkillFile(directory, skillFile.content)
  const { name, description, metadata } = frontmatter
  const entry: SkillManifestEntry = {
    name: name.trim(),
    description: description.trim(),
    body,
    resources: others.map(resourceOf),
  }
  if (metadata) entry.metadata = metadata
  if (metadata?.version !== undefined) entry.version = String(metadata.version)
  return entry
}

export function buildSkillManifest(files: readonly SkillFile[], fingerprint: string): SkillManifest {
  const skills: SkillManifestEntry[] = []
  for (const [directory, members] of groupByDirectory(sortedByPath(files))) {
    const skillFile = members.find(({ path }) => path === SKILL_FILE)
    if (!skillFile) continue
    const others = members.filter(({ path }) => path !== SKILL_FILE)
    skills.push(entryOf(directory, skillFile, others))
  }
  return { id: "builtin", fingerprint, skills }
}

const descriptorOf = (entry: SkillManifestEntry): SkillDescriptor => {
  const descriptor: SkillDescriptor = { name: entry.name, description: entry.description }
  if (entry.version !== undefined) descriptor.version = entry.version
  if (entry.metadata !== undefined) descriptor.metadata = entry.metadata
  return descriptor
}

const withoutContent = ({ content: _content, ...descriptor }: SkillResource): SkillResourceDescriptor => descriptor

const contentOf = (entry: SkillManifestEntry): SkillContent => ({
  ...descriptorOf(entry),
  body: entry.body,
  resources: (entry.resources ?? []).map(withoutContent),
})

export function manifestSource(manifest: SkillManifest): SkillSource {
  const entryNamed = (name: string) => manifest.skills.find((entry) => entry.name === name)
  return {
    id: manifest.id,
    fingerprint: manifest.fingerprint,
    list: async () => manifest.skills.map(descriptorOf),
    load: async (name) => {
      const entry = entryNamed(name)
      return entry ? contentOf(entry) : null
    },
    readResource: async (name, path) => {
      const resource = entryNamed(name)?.resources?.find((candidate) => candidate.path === path)
      return resource ? { ...resource } : null
    },
  }
}

const attributes = (pairs: readonly Attribute[]): string =>
  pairs.map(([name, value]) => (value === undefined ? "" : ` ${name}="${value.replaceAll('"', "&quot;")}"`)).join("")

const fileElement = (resource: SkillResourceDescriptor): string => {
  const size = resource.size === undefined ? undefined : String(resource.size)
  const opening = attributes([
    ["kind", resource.kind],
    ["encoding", resource.encoding ?? "text"],
    ["size", size],
  ])
  return `  <file${opening}>${resource.path}</file>`
}

const describeResource = (resource: SkillResourceDescriptor): string => {
  const details = [
    resource.kind,
    resource.encoding ?? "text",
    resource.mimeType,
    resource.size === undefined ? undefined : `${resource.size} bytes`,
  ].filter((detail) => detail !== undefined)
  return `- ${resource.path} (${details.join(", ")})`
}

const resourceElements = (resources: readonly SkillResourceDescriptor[]): string[] =>
  resources.length === 0 ? [] : ["<skill_resources>", ...resources.map(fileElement), "</skill_resources>"]

const resourceSummary = (resources: readonly SkillResourceDescriptor[]): string =>
  resources.length === 0
    ? "No bundled resources."
    : ["Bundled resources:", ...resources.map(describeResource)].join("\n")

export function renderActivatedSkill(skill: SkillContent): string {
  const resources = skill.resources ?? []
  const opening = attributes([
    ["name", skill.name],
    ["version", skill.version],
  ])
  return [
    `<skill_content${opening}>`,
    skill.body.trim(),
    ...resourceElements(resources),
    "</skill_content>",
    "",
    resourceSummary(resources),
  ].join("\n")
}

const skillResourceElement = (skillName: string, resource: SkillResource): string => {
  const opening = attributes([
    ["name", skillName],
    ["path", resource.path],
    ["kind", resource.kind],
    ["encoding", resource.encoding ?? "text"],
    ["mimeType", resource.mimeType],
  ])
  return [`<skill_resource${opening}>`, resource.content.trimEnd(), "</skill_resource>"].join("\n")
}

export function renderSkillWithResources(skill: SkillContent, resources: readonly SkillResource[]): string {
  const elements = resources.map((resource) => skillResourceElement(skill.name, resource))
  return [renderActivatedSkill(skill), ...elements].join("\n\n")
}

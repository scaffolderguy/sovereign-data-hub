import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Local-folder storage connector — the SDH reference backend (spec §4, v0.1).
 *
 * Root = a directory the customer chose (File System Access API in-browser, or a
 * filesystem path for the local agent). Each container is a subdirectory:
 *
 *   <root>/<container_id>/container.json
 *   <root>/<container_id>/payload/...
 *   <root>/<container_id>/assets/...
 *
 * The hub uses this; products never see it. Implements the tiny six-op
 * Connector Interface, with path-traversal and id guards so a manifest can't
 * reach outside its own container.
 */
export class LocalFolderConnector {
  private readonly root: string;
  constructor(root: string) {
    // Resolve to an absolute path. safeJoin() builds targets with path.resolve()
    // (absolute); if root stays relative (e.g. "./sdh-data") the traversal check
    // compares absolute-vs-relative and wrongly rejects every write.
    this.root = path.resolve(root);
  }

  // ---- Connector Interface -------------------------------------------------

  async listContainers(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    const ids: string[] = [];
    for (const e of entries) {
      if (e.isDirectory() && existsSync(path.join(this.root, e.name, "container.json"))) {
        ids.push(e.name);
      }
    }
    return ids;
  }

  async readManifest(id: string): Promise<unknown> {
    return JSON.parse(await readFile(path.join(this.dir(id), "container.json"), "utf8"));
  }

  async writeManifest(id: string, manifest: unknown): Promise<void> {
    const d = this.dir(id);
    await mkdir(d, { recursive: true });
    // Atomic: write to a temp file then rename, so an interrupted write never
    // leaves a half-written container.json.
    const dest = path.join(d, "container.json");
    const tmp = dest + ".tmp";
    await writeFile(tmp, JSON.stringify(manifest, null, 2));
    await rename(tmp, dest);
  }

  async readPayload(id: string, rel: string): Promise<Buffer> {
    return readFile(this.safeJoin(this.dir(id), rel));
  }

  async writePayload(id: string, rel: string, bytes: Buffer): Promise<void> {
    const p = this.safeJoin(this.dir(id), rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  /** Resolve a manifest asset pointer. This connector handles LOCAL pointers
   *  only (e.g. "assets/hero.png"); remote pointers (nas://, s3://, https://)
   *  belong to their own connectors and are rejected here. */
  async readAsset(id: string, pointer: string): Promise<Buffer> {
    this.assertLocal(pointer);
    return readFile(this.safeJoin(this.dir(id), pointer));
  }

  async writeAsset(id: string, pointer: string, bytes: Buffer): Promise<void> {
    this.assertLocal(pointer);
    const p = this.safeJoin(this.dir(id), pointer);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async listAssets(id: string): Promise<string[]> {
    const adir = path.join(this.dir(id), "assets");
    if (!existsSync(adir)) return [];
    const entries = await readdir(adir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => path.posix.join("assets", e.name));
  }

  // ---- guards --------------------------------------------------------------

  private dir(id: string): string {
    if (!/^sdh_[a-z0-9]+$/.test(id)) throw new Error(`SDH: invalid container id "${id}"`);
    return path.join(this.root, id);
  }

  private assertLocal(pointer: string): void {
    if (/^[a-z0-9]+:\/\//i.test(pointer)) {
      throw new Error(`SDH localFolder: remote pointer "${pointer}" needs its own connector`);
    }
  }

  /** Resolve rel under base and refuse anything that escapes base. */
  private safeJoin(base: string, rel: string): string {
    const full = path.resolve(base, rel);
    if (full !== base && !full.startsWith(base + path.sep)) {
      throw new Error(`SDH: path "${rel}" escapes the container`);
    }
    return full;
  }
}

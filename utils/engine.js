import {
  copy,
  emptyDir,
  ensureDir,
  exists,
} from "https://deno.land/std@0.173.0/fs/mod.ts";
import { parse as tomlParse } from "https://deno.land/std@0.173.0/encoding/toml.ts";
import { load as yamlLoad } from "https://deno.land/x/js_yaml_port@3.14.0/js-yaml.js";
import { posix } from "https://deno.land/std@0.173.0/path/mod.ts";
import * as syncTools from "./sync.lib.js";
import format from "https://deno.land/x/date_fns@v2.22.1/format/index.js";
import addDays from "https://deno.land/x/date_fns@v2.22.1/addDays/index.ts";

let _silentMode = false;
const thumbSizes = [150, 300, 500];

export class DeConfEngine {
  constructor(options = {}) {
    this.options = options;
    this.tag = this.options.tag || "dev";
    this.srcDir = this.options.srcDir || "./data";
    this.outputDir = this.options.outputDir || "./dist";
    this.publicUrl = this.options.publicUrl || "https://data.prgblockweek.com";
    this.exploreUrl = this.options.exploreUrl ||
      "https://explore.prgblockweek.com";
    this.githubUrl = this.options.githubUrl ||
      "https://github.com/utxo-foundation/prague-blockchain-week/tree/main/data";

    if (options.silent) {
      _silentMode = true;
    }
  }
  async init() {
    this.entries = [];
    for await (const f of Deno.readDir(this.srcDir)) {
      if (!f.name.match(/^\d+$/)) continue;
      const pkg = new DeConf_Package(f.name, this);
      await pkg.load([this.srcDir, f.name]);
      this.entries.push(pkg);
    }
  }
  async build() {
    await emptyDir(this.outputDir);
    console.log(`Tag: ${this.tag}`);
    await _textWrite([this.outputDir, "TAG"], this.tag);
    for (const pkg of this.entries) {
      console.table(pkg.data.events.map((e) => e.data.index), ["name"]);
      await pkg.write(this.outputDir);
    }
    await _jsonWrite(
      [this.outputDir, "index.json"],
      this.entries.map((p) => ({
        id: p.id,
        name: p.data.index.name,
        dataUrl: p.data.index.dataUrl,
        exploreUrl: p.data.index.exploreUrl,
        __time: new Date(),
        __tag: this.tag,
      })),
    );
    // write schemas
    const schemaVersion = 1;
    const schemas = await this.schemas(schemaVersion);

    const outputSchemaDir = [this.outputDir, "schema", schemaVersion].join("/");
    await emptyDir(outputSchemaDir);
    console.log(`writing schema (v${schemaVersion}) ..`);

    const schemaBundle = {};
    for (const schema of schemas) {
      await _jsonWrite(
        [outputSchemaDir, schema.name + ".json"],
        schema.schema,
      );
      schemaBundle[schema.name] = schema.schema;
    }
    await _jsonWrite([outputSchemaDir, "bundle.json"], {
      definitions: schemaBundle,
    });
  }
  async schemas(version = "1") {
    const schemaDir = `./utils/schema/${version}`;
    const arr = [];
    for await (const f of Deno.readDir(schemaDir)) {
      const m = f.name.match(/^(.+)\.yaml$/);
      if (!m) {
        continue;
      }
      arr.push({
        name: m[1],
        schema: Object.assign(
          { $id: this.schemaUrl(version, m[1]) },
          await _yamlLoad([schemaDir, f.name].join("/")),
        ),
      });
    }
    return arr.sort((x, y) => x.name > y.name ? 1 : -1);
  }
  schemaUrl(version = "1", type = "index") {
    return `${this.publicUrl}/schema/${version}/${type}.json`;
  }
  entriesList() {
    return this.entries.map((e) => e.id);
  }
}

class DeConf_Package {
  constructor(id, engine) {
    this.id = id;
    this.data = null;
    this.engine = engine;
    this.tag = engine.tag;
    this.colMapper = {
      places: "place",
      events: "event",
      "media-partners": "media-partner",
      contributors: "contributor",
      benefits: "benefit",
      unions: "union",
      chains: "chain",
      "other-events": "event",
    };
    this.collections = Object.keys(this.colMapper);
  }

  async load(specDir) {
    const pkg = {};
    // load year index
    pkg.index = await _tomlLoad([...specDir, "index.toml"].join("/"));
    pkg.index.dataUrl = [this.engine.publicUrl, this.id].join("/");
    pkg.index.exploreUrl = [this.engine.exploreUrl, this.id].join("/");
    pkg.index.dataGithubUrl = [this.engine.githubUrl, this.id].join("/");
    //console.log(`\n##\n## [${pkg.index.name}] \n##`);
    // load sub-events

    for (const colPlural of this.collections) {
      pkg[colPlural] = await this.loadCollection(specDir, colPlural);
    }

    this.data = pkg;
  }
  async write(dir) {
    const outputDir = [dir, this.id].join("/");
    await emptyDir(outputDir);
    await this.assetsWrite(outputDir);
    await _jsonWrite([outputDir, "index.json"], this.toJSON());
  }
  async loadCollection(specDir, type) {
    const arr = [];
    for await (const ef of Deno.readDir([...specDir, type].join("/"))) {
      if (ef.name.match(/^_/)) continue;
      const m = ef.name.match(/^([\w\d\-]+)(\.toml|)$/);
      if (!m) continue;
      const ev = new DeConf_Collection(type, m[1]);
      try {
        await ev.load([...specDir, type, ef.name]);
      } catch (e) {
        throw new Error(`[item=${m[1]}]: ${e}`);
      }
      arr.push(ev);
    }
    return arr;
  }
  async assetsWrite(outputDir) {
    for (const colName of this.collections) {
      const dir = [outputDir, "assets", colName].join("/");
      await emptyDir(dir);
      for (const item of this.data[colName]) {
        await item.assetsWrite(
          dir,
          [this.engine.publicUrl, this.id, "assets", colName].join(
            "/",
          ),
        );
      }
    }
  }
  toJSON() {
    return Object.assign({ id: this.id }, this.data.index, {
      ...Object.fromEntries(
        Object.keys(this.colMapper).map((col) => {
          return [col, this.data[col]];
        }),
      ),
      __time: new Date(),
      __tag: this.tag,
    });
  }
}

class DeConf_Collection {
  constructor(type, id) {
    this.type = type;
    this.id = id;
    this.data = null;
    this.dir = null;
    this.assets = ["logo", "photo"];
    this.haveSync = false;
    this.dataFile = null;
  }

  async load(path) {
    let fn;
    if (path[path.length - 1].match(/^(.+)\.toml$/)) {
      fn = path;
    } else {
      this.dir = path.join("/");
      fn = [...path, "index.toml"];
    }

    this.dataFile = [this.dir, "data.json"].join("/");

    const efIndex = await _tomlLoad(fn.join("/"));
    const hash = await _makeHash([this.type, this.id].join(":"));
    const data = {
      index: { id: this.id, hash, ...efIndex },
    };
    if (["events", "other-events"].includes(this.type)) {
      // add Event Segments
      if (!data.index.segments) {
        data.index.segments = [];
        for (let i = 0; i < data.index.days; i++) {
          data.index.segments.push({
            date: format(addDays(new Date(data.index.date), i), "yyyy-MM-dd"),
            times: data.index.times || "09:00-18:00",
          });
        }
      }
      for (const sg of data.index.segments) {
        if (sg.remote) {
          continue;
        }
        const [sstart, send] = sg.times.split("-");
        sg.startTime = (new Date(`${sg.date}T${sstart}`)).toISOString();
        const endDate = send <= sstart
          ? format(addDays(new Date(sg.date), 1), "yyyy-MM-dd")
          : sg.date;
        sg.endTime = (new Date(`${endDate}T${send}`)).toISOString();
      }
    }
    if (this.dir && !data.index.hidden) {
      const syncDataFn = [this.dir, "data.json"].join("/");
      if (await exists(syncDataFn)) {
        data.sync = await _jsonLoad(syncDataFn);
      }
      for (const asset of this.assets) {
        if (data.index[asset]) {
          const assetFn = [this.dir, data.index[asset]].join("/");
          if (!await exists(assetFn)) {
            throw new Error(`Asset not exists: ${assetFn}`);
          }
        }
      }
    }
    // check if sync file exists
    this.syncFile = [this.dir, "_sync.js"].join("/");
    if (await exists(this.syncFile)) {
      this.haveSync = true;
    }
    this.data = data;
  }

  async optimizeImages() {
    for (const as of this.assets) {
      if (this.data.index[as]) {
        await this.optimizeImageFile(this.data.index[as]);
      }
    }
    if (this.data.index?.speakers) {
      for (const s of this.data.index.speakers) {
        await this.optimizeImageFile(s.photo);
      }
    }
    if (this.data.sync?.speakers) {
      for (const s of this.data.sync.speakers) {
        await this.optimizeImageFile(s.photo);
      }
    }
  }

  async optimizeImageFile(fn) {
    if (!fn) {
      return null;
    }
    const src = [this.dir, fn].join("/");
    const extname = posix.extname(src);
    const dest = [this.dir, fn.replace(/\.([^\.]+)$/, ".op.webp")].join("/");
    if (!await exists(dest)) {
      if (extname === ".webp") {
        await _fileCopy(src, dest);
        console.log(`${dest} copied`);
        return true;
      }
      await _imageOptimalizedWrite(src, dest);
      console.log(`${dest} writed`);
    }
    const info = await _imageWebPInfo(dest);
    if (!info) {
      return null;
    }
    const longer = info.width > info.height ? "w" : "h";
    const ratio = longer === "h"
      ? (info.width / info.height)
      : (info.height / info.width);
    for (const sz of thumbSizes) {
      const pxs = longer === "h"
        ? [sz, Math.round(sz / ratio)]
        : [Math.round(sz / ratio), sz];
      //console.log(`size=${sz} px_orig=${[info.width, info.height]} px=${pxs}`)
      //console.log(info.width, info.height, ratio, sz, cheight)
      const szDest = [this.dir, fn.replace(/\.([^\.]+)$/, `-${sz}px.op.webp`)]
        .join("/");
      if (!await exists(szDest)) {
        await _imageOptimalizedWrite(dest, szDest, pxs);
        console.log(`${szDest} writed`);
      }
    }
  }

  async sync() {
    if (!this.haveSync) return null;
    if (!_silentMode) console.log(`syncing ${this.id} ..`);
    const module = await import("../" + this.syncFile);
    // data
    if (module.data) {
      const data = await module.data(syncTools);
      if (!JSON.stringify(data)) {
        return null;
      }

      if (data.speakers) {
        data.speakers = data.speakers.sort((x, y) => x.id > y.id ? 1 : -1);
        const photosDir = [this.dir, "photos"].join("/");
        await ensureDir(photosDir);
        for (const sp of data.speakers) {
          if (!sp.photoUrl) continue;
          const ext = await posix.extname(sp.photoUrl);
          const dir = [photosDir, "speakers"].join("/");
          const ffn = (sp.id ? sp.id : nameId) + ext.replace(/\?.+$/, "");
          const fn = [dir, ffn].join("/");
          if (await exists(fn)) {
            sp.photo = ["photos", "speakers", ffn].join("/");
            continue;
          }
          await ensureDir(dir);
          const nameId = sp.id || sp.name.toLowerCase().replace(/ /g, "-");
          const photoFetch = await fetch(sp.photoUrl);
          if (!photoFetch.body) {
            continue;
          }
          const tmpfile = [dir, ffn].join("/");
          const file = await Deno.open(tmpfile, { write: true, create: true });
          await photoFetch.body.pipeTo(file.writable);
          //await _imageOptimalizedWrite(tmpfile, fn);
          console.log(`${fn} writed`);

          sp.photo = ["photos", "speakers", ffn].join("/");
        }
      }
      await _jsonWrite(this.dataFile, data);
      this.data.sync = data;
    }
  }

  async assetsWrite(outputDir, publicUrl) {
    const x = { ...this.data.sync, ...this.data.index };

    const writeImage = async (fn, outDir, fnRename = null) => {
      const srcFile = [this.dir, fn].join("/");
      if (await exists(srcFile)) {
        const outFile = [outDir, fnRename || posix.basename(fn)].join("/");
        await _fileCopy(srcFile, outFile);
      }
    };
    const writeImageBundle = async (src, outDir) => {
      await ensureDir(outDir);
      //await writeImage(src, outDir)
      //await writeImage(src.replace(/\.(.+)$/, '.op.webp'), outDir, posix.basename(src).replace(/\.(.+)$/, `.webp`))
      await writeImage(
        src.replace(/\.(.+)$/, "-500px.op.webp"),
        outDir,
        posix.basename(src).replace(/\.(.+)$/, `.webp`),
      );
      for (const sz of thumbSizes) {
        await writeImage(
          src.replace(/\.(.+)$/, `-${sz}px.op.webp`),
          outDir,
          posix.basename(src).replace(/\.(.+)$/, `_${sz}px.webp`),
        );
      }
    };
    for (const asset of this.assets) {
      if (!x[asset]) continue;

      const outDir = [outputDir, this.id].join("/");
      await emptyDir(outDir);
      await writeImageBundle(x[asset], outDir);
      const fnOut = [this.id, x[asset].replace(/\.[^.]+$/, ".webp")].join("/");
      const url = [publicUrl, fnOut].join("/");
      this.data.index[asset] = url;
    }

    const speakersCol = this.data.sync
      ? this.data.sync.speakers
      : this.data.index.speakers;
    if (speakersCol) {
      const outDir = [outputDir, this.id, "photos", "speakers"].join("/");
      for (const sp of speakersCol) {
        if (!sp.photo) continue;
        await writeImageBundle(sp.photo, outDir);

        sp.photoUrl = [
          publicUrl,
          this.id,
          "photos",
          "speakers",
          posix.basename(sp.photo).replace(/\.[^.]+$/, ".webp"),
        ].join("/");
      }
    }
  }

  opResolve(fn) {
    return [fn.replace(/[^\.]+$/, "op.webp"), fn.replace(/[^\.]+$/, "webp")];
  }

  toJSON() {
    return Object.assign({ id: this.id }, this.data.index, this.data.sync);
  }
}

async function _imageWebPInfo(src) {
  const p = Deno.run({
    cmd: ["webpinfo", src],
    stdout: "piped",
    stderr: "piped",
  });
  await p.status();
  const info = new TextDecoder().decode(await p.output());
  if (!info.trim()) {
    console.log(src);
    return null;
  }
  return {
    size: Number(info.match(/File size:\s+(\d+)/)[1]),
    width: Number(info.match(/Width: (\d+)/)[1]),
    height: Number(info.match(/Height: (\d+)/)[1]),
  };
}

async function _imageOptimalizedWrite(src, dest, resize = null) {
  const cmd = [
    "cwebp",
    ...(resize ? ["-resize", resize[0], resize[1]] : []),
    "-q",
    "80",
    src,
    "-o",
    dest,
  ];
  const p = Deno.run({ cmd, stdout: "piped", stderr: "piped" });
  await p.status();
  //const err = new TextDecoder().decode(await p.stderrOutput())
  //console.log(err)
}

async function _fileCopy(from, to) {
  await copy(from, to, { overwrite: true });
  if (!_silentMode) {
    console.log(`${from} copied to ${to}`);
  }
  return true;
}
async function _tomlLoad(fn) {
  return tomlParse(await Deno.readTextFile(fn));
}
async function _yamlLoad(fn) {
  return yamlLoad(await Deno.readTextFile(fn));
}
async function _jsonWrite(fn, data) {
  if (Array.isArray(fn)) {
    fn = fn.join("/");
  }
  await Deno.writeTextFile(fn, JSON.stringify(data, null, 2));
  if (!_silentMode) {
    console.log(`${fn} writed`);
  }
  return true;
}
async function _textWrite(fn, text) {
  if (Array.isArray(fn)) {
    fn = fn.join("/");
  }
  await Deno.writeTextFile(fn, text);
}
async function _jsonLoad(fn) {
  return JSON.parse(await Deno.readTextFile(fn));
}

async function _makeHash(str) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", (new TextEncoder()).encode(str)),
    ),
  ).map((b) => b.toString(16).padStart(2, "0")).join("");
}

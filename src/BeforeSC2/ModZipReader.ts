import JSZip from "jszip";
import {get as keyval_get, set as keyval_set, del as keyval_del, createStore, UseStore} from 'idb-keyval';
import {SC2DataInfo} from "./SC2DataInfoCache";
import {checkDependenceInfo, checkModBootJsonAddonPlugin, ModBootJson, ModImgGetterDefault, ModInfo} from "./ModLoader";
import {getLogFromModLoadControllerCallback, LogWrapper, ModLoadControllerCallback} from "./ModLoadController";
import {extname} from "./extname";
import {ReplacePatcher, checkPatchInfo} from "./ReplacePatcher";
import JSON5 from 'json5';

import xxHash from "xxhash-wasm";
import {JSZipLikeReadOnlyInterface} from "./JSZipLikeReadOnlyInterface";
import {ModPackFileReaderJsZipAdaptor} from "./ModPack/ModPackJsZipAdaptor";

const isString = (value: unknown): value is string => typeof value === 'string';
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

interface RuntimeCapacity {
    modPrefetch: number;
    fileReads: number;
}

function runtimeCapacity(): RuntimeCapacity {
    const runtimeNavigator = typeof navigator === 'undefined'
        ? undefined
        : navigator as Navigator & {deviceMemory?: number};
    const cores = runtimeNavigator?.hardwareConcurrency || 2;
    const memory = Number(runtimeNavigator?.deviceMemory || 0);
    if (cores <= 4 || (memory > 0 && memory <= 4)) return {modPrefetch: 1, fileReads: 2};
    if (cores >= 12 && (memory === 0 || memory >= 8)) return {modPrefetch: 2, fileReads: 6};
    return {modPrefetch: 2, fileReads: 3};
}

async function mapLimited<T, R>(items: readonly T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    async function worker(): Promise<void> {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index]);
        }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, () => worker()));
    return results;
}

function yieldToMainThread(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}
// import moment from "moment";

let xxHashApi: Awaited<ReturnType<typeof xxHash>> | undefined;

export async function getXxHash() {
    if (!xxHashApi) {
        xxHashApi = await xxHash();
    }
    return xxHashApi;
}

export interface Twee2PassageR {
    name: string;
    tags: string[];
    content: string;
}

function base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

type ModZipData = string | Uint8Array;

async function modBootJson(modData: ModZipData): Promise<ModBootJson | string> {
    const options = {base64: typeof modData === 'string'};
    const modPack = await new ModPackFileReaderJsZipAdaptor().loadAsync(modData, options);
    const zip: JSZipLikeReadOnlyInterface = modPack ?? await JSZip.loadAsync(modData, options);
    const bootJsonFile = zip.file(ModZipReader.modBootFilePath);
    if (!bootJsonFile) return `bootJsonFile ${ModZipReader.modBootFilePath} Invalid`;

    const bootJson = JSON5.parse(await bootJsonFile.async('string'));
    return ModZipReader.validateBootJson(bootJson) ? bootJson : 'bootJson Invalid';
}

type IndexDBModPartsRecord = [
    partSize: number,
    partCount: number,
    byteLength: number,
    partKey: string,
];

type IndexDBBundledModItem = {
    builtin?: boolean,
    name?: string,
    data?: string,
    dataParts?: string[],
    hash?: string,
};

export function Twee2Passage2(s: string): Twee2PassageR[] {
    const tweeList: Twee2PassageR[] = [];
    const lines = s.split(/\r?\n/);
    // let lastTwee: Twee2PassageR = {
    //     name: '',
    //     tags: [],
    //     content: '',
    // };
    let lastTwee: Twee2PassageR | undefined = undefined;
    let lastStartLine = -1;
    for (let i = 0; i < lines.length; ++i) {
        const l = lines[i];
        if (l.startsWith(':: ')) {
            const r = l.split('[');

            const a = r[0];
            const name = a.slice(':: '.length);

            const nextTwee: Twee2PassageR = {
                name: name.trim(),
                tags: [],
                content: '',
            };

            if (r.length < 2) {
                nextTwee.tags = [];
            } else {
                if (!r[1].includes(']')) {
                    // bad
                    continue;
                }
                const b = r[1].split(']')[0];

                nextTwee.tags = b.split(' ').map(T => T.trim());
            }

            if (lastTwee) {
                lastTwee.content = lines.slice(lastStartLine + 1, i).join('\n');
                tweeList.push(lastTwee);
            }
            lastTwee = nextTwee;
            lastStartLine = i;

        }
    }
    if (lastTwee) {
        lastTwee.content = lines.slice(lastStartLine + 1).join('\n');
        tweeList.push(lastTwee);
    }
    return tweeList;
}

export function Twee2Passage(s: string): Twee2PassageR[] {
    // match:
    //      :: Widgets Bodywriting Objects [widget]
    //      :: Widgets Bodywriting Objects
    //      :: Widgets Bodywriting Objects [widget asdasd]
    // special allow :
    //      :: Widgets Bodywriting Objects []
    // const r = s.split(/^(:: +((?:[^:"\\/\n\r\[\] ]+ *)+)(?: +\[((?:\w+ *)+)?\] *|))$/gm);
    // :: Widgets Bodywriting Objects [widget asdasd aaa©复活😊]
    // const r = s.split(/^(:: +((?:[^:"\/\n\r\[\] ]+ *)+)(?: *\[((?:[^ \]]+ *)+ *)\] *|))$/gm);
    // :: Widgets Bodywriting Objects []
    const r = s.split(/^(:: +((?:[^:"\/\n\r\[\] ]+ *)+)(?: *\[((?:[^ \]]+ *)* *)\] *|))$/gm);
    // console.log('Twee2Passage split ', r, [s]);
    // ['xxx', ':: Widgets Bodywriting Objects [widget]', 'Widgets Bodywriting Objects', 'widget', 'xxx']
    // ['xxx', ':: Widgets Bodywriting Objects [widget]', 'Widgets Bodywriting Objects', undefined, 'xxx']
    const rr: Twee2PassageR[] = [];
    for (let i = 0; i < r.length; i++) {
        if (r[i].startsWith(':: ')) {
            rr.push({
                name: r[++i].trim(),
                tags: r[++i]?.split(' ') || [],
                content: r[++i],
            });
        }
    }
    return rr;
}

export function imgWrapBase64Url(fileName: string, base64: string) {
    let ext = extname(fileName);
    if (ext.startsWith('.')) {
        ext = ext.substring(1);
    }
    // console.log('imgWrapBase64Url', [fileName, ext, base64]);
    return `data:image/${ext};base64,${base64}`;
}

export async function blobToBase64(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // reader.result包含了base64数据URL，格式如: data:image/jpeg;base64,/9j/4AAQ...
            // 如果只需要base64字符串部分，可以用split(',')[1]获取
            resolve((reader.result as string).split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

export class ModZipReaderHash {
    _hash: string | undefined;
    _zipBase64String: ModZipData | undefined;

    constructor(
        zipBase64String: ModZipData | undefined,
        hash?: string | undefined,
    ) {
        if (hash) {
            this._hash = hash;
        } else {
            if (!zipBase64String || zipBase64String.length === 0) {
                // never go there
                console.error('[ModZipReaderHash] constructor zipBase64String is undefined if hash is undefined.');
                throw new Error('[ModZipReaderHash] constructor zipBase64String is undefined if hash is undefined.');
            }
            this._zipBase64String = zipBase64String;
        }
    }

    protected async digestMessage(message: ModZipData) {
        // const t1 = moment();
        // const r = (await getXxHash()).h64ToString(message);
        // const t2 = moment();
        // console.log('digestMessage', r, t2.diff(t1));
        // return r;
        const api = await getXxHash();
        if (typeof message === 'string') {
            return api.h64ToString(message);
        }
        return this.XxHashH64Bigint2String(api.h64Raw(message));
    }

    // https://github.com/jungomi/xxhash-wasm/blob/5923f26411ed763044bed17a1fec33fee74e47a0/src/xxhash.js#L148
    protected XxHashH64Bigint2String(h64: bigint): string {
        return h64.toString(16).padStart(16, "0");
    }

    protected XxHashH32Number2String(h32: bigint): string {
        return h32.toString(16).padStart(8, "0");
    }

    async init() {
        if (this._hash) {
            this._zipBase64String = undefined;
            return;
        }
        if (!this._zipBase64String) {
            // never go there
            console.error('[ModZipReaderHash] init() this._zipBase64String is undefined.');
            throw new Error('[ModZipReaderHash] init() this._zipBase64String is undefined.');
        }
        this._hash = await this.digestMessage(this._zipBase64String);
        this._zipBase64String = undefined;
    }

    compare(h: ModZipReaderHash) {
        return this._hash === h._hash;
    }

    compareWithString(h: string) {
        try {
            return this._hash === this.fromString(h);
        } catch (e) {
            return false;
        }
    }

    toString() {
        if (!this._hash) {
            // never go there
            console.error('[ModZipReaderHash] toString() this._hash is undefined.');
            throw new Error('[ModZipReaderHash] toString() this._hash is undefined.');
        }
        return this._hash;
    }

    fromString(hash: string): string {
        return hash;
    }

}

export class ModZipReader {

    public log: LogWrapper;

    private gcFinalizationRegistry;

    private _zip: JSZipLikeReadOnlyInterface | undefined;
    // NOTE: the WeakRef cannot work on all browser, temp disable it.
    // private _zipWeakRef: WeakRef<JSZip>;
    private _zipIsExist: boolean | null;

    public get zip(): JSZipLikeReadOnlyInterface {
        if (!this._zip) {
            console.error('ModZipReader zip was released.', [this.modInfo, this]);
            this.log.error(`ModZipReader zip was released. [${this.modInfo?.name}]`);
            throw new Error(`ModZipReader zip was released. [${this.modInfo?.name}]`);
        }
        return this._zip;
    }

    public modZipReaderHash: ModZipReaderHash;

    constructor(
        zip: JSZipLikeReadOnlyInterface,
        zipBase64String: ModZipData,
        public loaderBase: LoaderBase,
        public modLoadControllerCallback: ModLoadControllerCallback,
    ) {
        this.log = getLogFromModLoadControllerCallback(modLoadControllerCallback);
        if (typeof FinalizationRegistry === 'undefined') {
            this.gcFinalizationRegistry = new FinalizationRegistryMock(() => {
                // never be call
            });
            this._zipIsExist = null;
            console.warn('ModZipReader FinalizationRegistry is not support.');
        } else {
            this.gcFinalizationRegistry = new FinalizationRegistry(() => {
                console.log('ModZipReader zip was released.', [this.modInfo, this]);
                this._zipIsExist = true;
            });
            this._zipIsExist = false;
            // console.warn('ModZipReader FinalizationRegistry is support.');
        }
        // this._zipWeakRef = new WeakRef(zip);
        this._zip = zip;
        this.modZipReaderHash = new ModZipReaderHash(zipBase64String, zip.hashString);
        this.gcFinalizationRegistry.register(this._zip, undefined, this);
    }

    get isModPack() {
        return this.zip.is_JeremieModLoader_ModPack === true;
    }

    get isJsZip() {
        return this.zip.is_JeremieModLoader_ModPack === undefined;
    }

    modInfo?: ModInfo;

    public getModInfo() {
        return this.modInfo;
    }

    public getZipFile() {
        return this._zip;
    }

    /**
     * use this to release zip object ref, try to remove the object from memory.
     */
    public gcReleaseZip() {
        console.log(`ModLoader ====== ModZipReader gcReleaseZip [${this.modInfo?.name}]`);
        this.log.log(`ModLoader ====== ModZipReader gcReleaseZip [${this.modInfo?.name}]`);
        this._zip = undefined;
    }

    /**
     * use this to debug check if the zip object is really released.
     * @return [isRefExist(true), isWeakRefExist(false), isWeakRefCleanBeCall(true/(null if not support))]
     *       only when the return is [true, false, true] the zip object is really released.
     */
    public gcCheckReleased(): [boolean,/* boolean,*/ boolean | null] {
        return [
            !!this._zip,
            // !!this._zipWeakRef.deref(),
            this._zipIsExist,
        ];
    }

    public gcIsReleased(): boolean {
        return !this._zip;
    }

    static validateBootJson(bootJ: unknown, log?: LogWrapper): bootJ is ModBootJson {
        if (!isPlainObject(bootJ)) {
            log?.error('validateBootJson failed: boot.json must be an object');
            return false;
        }

        const checks: Record<string, boolean> = {
            name: isString(bootJ.name) && bootJ.name.length > 0,
            version: isString(bootJ.version) && bootJ.version.length > 0,
            styleFileList: isStringArray(bootJ.styleFileList),
            scriptFileList: isStringArray(bootJ.scriptFileList),
            tweeFileList: isStringArray(bootJ.tweeFileList),
            imgFileList: isStringArray(bootJ.imgFileList),
        };

        const optional = (key: string, validate: (value: unknown) => boolean) =>
            !hasOwn(bootJ, key) || validate(bootJ[key]);

        checks.nickName = optional('nickName', value => isString(value) || isPlainObject(value));
        checks.alias = optional('alias', isStringArray);
        checks.dependenceInfo = optional('dependenceInfo', value =>
            Array.isArray(value) && value.every(checkDependenceInfo));
        checks.addonPlugin = optional('addonPlugin', value =>
            Array.isArray(value) && value.every(checkModBootJsonAddonPlugin));
        checks.replacePatchList = optional('replacePatchList', isStringArray);
        checks.scriptFileList_preload = optional('scriptFileList_preload', isStringArray);
        checks.scriptFileList_earlyload = optional('scriptFileList_earlyload', isStringArray);
        checks.scriptFileList_inject_early = optional('scriptFileList_inject_early', isStringArray);

        const invalidFields = Object.entries(checks)
            .filter(([, valid]) => !valid)
            .map(([field]) => field);

        if (invalidFields.length > 0) {
            log?.error(`validateBootJson failed: ${invalidFields.join(', ')}`);
            return false;
        }
        return true;
    }

    static modBootFilePath = 'boot.json';

    private reportMissingFile(kind: string, path: string, level: 'warn' | 'error' = 'warn') {
        const message = `cannot get ${kind} file from mod zip: [${this.modInfo?.name ?? 'unknown'}] [${path}]`;
        console[level](message);
        this.log[level](message);
    }

    private async readTextFile(path: string, kind: string, level: 'warn' | 'error' = 'warn') {
        const file = this.zip.file(path);
        if (!file) {
            this.reportMissingFile(kind, path, level);
            return undefined;
        }
        return file.async('string');
    }

    private async loadScriptFiles(
        paths: string[] | undefined,
        target: Array<[string, string]>,
        kind: string,
    ) {
        const filePaths = paths ?? [];
        const contents = await mapLimited(filePaths, runtimeCapacity().fileReads, path => this.readTextFile(path, kind));
        for (let index = 0; index < filePaths.length; index++) {
            const data = contents[index];
            if (data !== undefined) target.push([filePaths[index], data]);
        }
    }



    async init() {
        await this.modZipReaderHash.init();
        const bootJsonFile = this.zip.file(ModZipReader.modBootFilePath);
        if (!bootJsonFile) {
            console.log('ModLoader ====== ModZipReader init() cannot find :', ModZipReader.modBootFilePath);
            return false;
        }
        const bootJson = await bootJsonFile.async('string');
        const bootJ = JSON5.parse(bootJson);
        if (ModZipReader.validateBootJson(bootJ, this.log)) {
            this.modInfo = {
                name: bootJ.name,
                nickName: bootJ.nickName || undefined,
                alias: bootJ.alias ?? [],
                version: bootJ.version,
                cache: new SC2DataInfo(
                    this.log,
                    bootJ.name,
                ),
                imgs: [],
                imgFileReplaceList: [],
                scriptFileList_preload: [],
                scriptFileList_earlyload: [],
                scriptFileList_inject_early: [],
                replacePatcher: [],
                bootJson: bootJ,
                modRef: undefined,
            };
            this.loaderBase.addZipFile(bootJ.name, this);
            // console.log('ModLoader ====== ModZipReader init() modInfo', this.modInfo);

            for (const replacePatchPath of bootJ.replacePatchList || []) {
                const replacePatchFile = this.zip.file(replacePatchPath);
                if (replacePatchFile) {
                    const data = await replacePatchFile.async('string');
                    try {
                        const d = JSON5.parse(data);
                        if (checkPatchInfo(d)) {
                            this.modInfo.replacePatcher.push(new ReplacePatcher(
                                this.log,
                                this.modInfo.name,
                                replacePatchPath,
                                d,
                            ));
                        } else {
                            console.error('ModLoader ====== ModZipReader init() replacePatchFile Invalid:', [this.modInfo.name, replacePatchPath]);
                            this.log.error(`ModLoader ====== ModZipReader init() replacePatchFile Invalid: [${this.modInfo.name}] [${replacePatchPath}]`);
                        }
                    } catch (e) {
                        console.error('ModLoader ====== ModZipReader init() replacePatchFile Invalid:', [this.modInfo.name, replacePatchPath]);
                        this.log.error(`ModLoader ====== ModZipReader init() replacePatchFile Invalid: [${this.modInfo.name}] [${replacePatchPath}]`);
                    }
                } else {
                    this.reportMissingFile('replacePatchFile', replacePatchPath);
                }
            }
            for (const imgPath of bootJ.imgFileList || []) {
                const imgFile = this.zip.file(imgPath);
                if (imgFile) {
                    this.modInfo.imgs.push({
                        // data: imgWrapBase64Url(imgPath, data),
                        getter: new ModImgGetterDefault(bootJ.name, this, imgPath, this.log),
                        path: imgPath,
                    });
                } else {
                    this.reportMissingFile('imgFileList', imgPath, 'error');
                }
            }
            await this.constructModInfoCache(bootJ, false);

            await this.loadScriptFiles(bootJ.scriptFileList_preload, this.modInfo.scriptFileList_preload, 'scriptFileList_preload');
            await this.loadScriptFiles(bootJ.scriptFileList_earlyload, this.modInfo.scriptFileList_earlyload, 'scriptFileList_earlyload');
            await this.loadScriptFiles(bootJ.scriptFileList_inject_early, this.modInfo.scriptFileList_inject_early, 'scriptFileList_inject_early');

            this.log.log(`ModLoader ====== ModZipReader init() modInfo: [${this.modInfo.name}] [${this.modInfo.version}]`);

            return true;
        }
        return false;
    }

    async refillCacheStyleFileItems(styleFileList: string[], keepOld: boolean) {
        if (!this.modInfo) {
            console.error('ModLoader ====== ModZipReader refillCacheStyleFileItems() (!this.modInfo).', [this.modInfo]);
            this.log.error(`ModLoader ====== ModZipReader refillCacheStyleFileItems() (!this.modInfo).`);
            return;
        }

        if (!keepOld) {
            this.modInfo.cache.styleFileItems.items = [];
        }
        for (const stylePath of styleFileList) {
            const data = await this.readTextFile(stylePath, 'styleFileList');
            if (data === undefined) continue;
            this.modInfo.cache.styleFileItems.items.push({
                name: stylePath,
                content: data,
                id: 0,
            });
        }
        this.modInfo.cache.styleFileItems.fillMap();
    }

    async refillCachePassageDataItems(tweeFileList: string[], keepOld: boolean) {
        if (!this.modInfo) {
            console.error('ModLoader ====== ModZipReader refillCachePassageDataItems() (!this.modInfo).', [this.modInfo]);
            this.log.error(`ModLoader ====== ModZipReader refillCachePassageDataItems() (!this.modInfo).`);
            return;
        }

        if (!keepOld) {
            this.modInfo.cache.passageDataItems.items = [];
        }
        for (const tweePath of tweeFileList) {
            const data = await this.readTextFile(tweePath, 'tweeFileList', 'error');
            if (data === undefined) continue;
            for (const passage of Twee2Passage(data)) {
                this.modInfo.cache.passageDataItems.items.push({
                    name: passage.name,
                    content: passage.content,
                    id: 0,
                    tags: passage.tags,
                });
            }
        }
        this.modInfo.cache.passageDataItems.fillMap();

    }

    async refillCacheScriptFileItems(scriptFileList: string[], keepOld: boolean) {
        if (!this.modInfo) {
            console.error('ModLoader ====== ModZipReader refillCacheScriptFileItems() (!this.modInfo).', [this.modInfo]);
            this.log.error(`ModLoader ====== ModZipReader refillCacheScriptFileItems() (!this.modInfo).`);
            return;
        }

        if (!keepOld) {
            this.modInfo.cache.scriptFileItems.items = [];
        }
        for (const scPath of scriptFileList) {
            const data = await this.readTextFile(scPath, 'scriptFileList', 'error');
            if (data === undefined) continue;
            this.modInfo.cache.scriptFileItems.items.push({
                name: scPath,
                content: data,
                id: 0,
            });
        }
        this.modInfo.cache.scriptFileItems.fillMap();
    }

    async constructModInfoCache(bootJ: ModBootJson, keepOld: boolean) {
        if (!this.modInfo) {
            console.error('ModLoader ====== ModZipReader constructModInfoCache() (!this.modInfo).', [this.modInfo]);
            this.log.error(`ModLoader ====== ModZipReader constructModInfoCache() (!this.modInfo).`);
            return;
        }

        await Promise.all([
            this.refillCacheStyleFileItems(bootJ.styleFileList, keepOld),
            this.refillCachePassageDataItems(bootJ.tweeFileList, keepOld),
            this.refillCacheScriptFileItems(bootJ.scriptFileList, keepOld),
        ]);

    }
}

export class LoaderBase {
    modList: ModZipReader[] = [];
    modZipList: Map<string, ModZipReader[]> = new Map<string, ModZipReader[]>();

    logger: Record<'log' | 'warn' | 'error', ((s: string) => void)>;

    constructor(
        public log: ModLoadControllerCallback,
        public loaderKeyConfig: LoaderKeyConfig,
    ) {
        this.logger = {
            log: (s: string) => {
                this.log.logInfo(s);
            },
            warn: (s: string) => {
                this.log.logWarning(s);
            },
            error: (s: string) => {
                this.log.logError(s);
            },
        }
    }

    init() {
        // this is used for override
    }

    getZipFile(name: string) {
        return this.modZipList.get(name);
    }

    addZipFile(name: string, zip: ModZipReader) {
        if (this.modZipList.has(name)) {
            console.warn('ModLoader ====== LoaderBase addZipFile() [warn!!!] duplicate mod name:', name);
            this.log.logWarning(`LoaderBase addZipFile() [warn!!!] duplicate mod name: [${name}]`);
            this.modZipList.get(name)!.push(zip);
            return;
        }
        this.modZipList.set(name, [zip]);
    }

    protected async initZipReader(
        zipSource: string | Uint8Array | Blob,
        options?: {base64?: boolean},
    ): Promise<ModZipReader | undefined> {
        try {
            const modPack = await new ModPackFileReaderJsZipAdaptor().loadAsync(zipSource, options);
            const zip: JSZipLikeReadOnlyInterface = modPack ?? await JSZip.loadAsync(zipSource, options);

            let hashSource: ModZipData = '';
            if (!zip.hashString) {
                hashSource = zipSource instanceof Blob
                    ? new Uint8Array(await zipSource.arrayBuffer())
                    : zipSource;
            }

            const reader = new ModZipReader(zip, hashSource, this, this.log);
            if (!await reader.init()) return undefined;

            this.modList.push(reader);
            return reader;
        } catch (error) {
            console.error(error);
            return undefined;
        }
    }

    async load(): Promise<boolean> {
        throw new Error('LoaderBase load() not implement');
    }
}

export class LocalStorageLoader extends LoaderBase {

    static modDataLocalStorageZipList = 'modDataLocalStorageZipList';
    static modDataLocalStorageZipPrefix = 'modDataLocalStorageZip';

    override init() {
        super.init();
        LocalStorageLoader.modDataLocalStorageZipList = this.loaderKeyConfig.getLoaderKey(LocalStorageLoader.modDataLocalStorageZipList, LocalStorageLoader.modDataLocalStorageZipList);
        LocalStorageLoader.modDataLocalStorageZipPrefix = this.loaderKeyConfig.getLoaderKey(LocalStorageLoader.modDataLocalStorageZipPrefix, LocalStorageLoader.modDataLocalStorageZipPrefix);
    }

    async load(): Promise<boolean> {

        const listFile = localStorage.getItem(LocalStorageLoader.modDataLocalStorageZipList);
        if (!listFile) {
            return false;
        }
        let list: string[];
        try {
            list = JSON5.parse(listFile);
        } catch (e) {
            console.error(e);
            return false;
        }
        if (!isStringArray(list)) {
            return false;
        }


        // modDataBase64ZipStringList: base64[]
        for (const zipPath of list) {
            const base64ZipString = localStorage.getItem(LocalStorageLoader.calcModNameKey(zipPath));
            if (!base64ZipString) {
                console.error('ModLoader ====== LocalStorageLoader load() cannot get zipPath:', zipPath);
                // this.logger.error(`ModLoader ====== LocalStorageLoader load() cannot get zipPath:[${zipPath}]`);
                continue;
            }
            await this.initZipReader(base64ZipString, {base64: true});
        }

        return true;
    }

    static listMod() {
        const ls = localStorage.getItem(this.modDataLocalStorageZipList);
        if (!ls) {
            console.log('ModLoader ====== LocalStorageLoader listMod() cannot find modDataLocalStorageZipList');
            return undefined;
        }
        try {
            const l = JSON5.parse(ls);
            console.log('ModLoader ====== LocalStorageLoader listMod() modDataLocalStorageZipList', l);
            if (isStringArray(l)) {
                return l;
            }
        } catch (e) {
            console.error(e);
        }
        console.log('ModLoader ====== LocalStorageLoader listMod() modDataLocalStorageZipList Invalid');
        return undefined;
    }

    static calcModNameKey(name: string) {
        return `${this.modDataLocalStorageZipPrefix}:${name}`;
    }

    static removeMod(name: string) {
        let l = this.listMod() || [];
        l = l.filter(T => T !== name);
        const k = this.calcModNameKey(name);
        localStorage.setItem(this.modDataLocalStorageZipList, JSON.stringify(l));
        localStorage.removeItem(k);
    }

    // get bootJson from zip
    static async checkModZipFile(modBase64String: string) {
        return modBootJson(modBase64String);
    }

    static addMod(name: string, modBase64String: string) {
        const l = new Set(this.listMod() || []);
        const k = this.calcModNameKey(name);
        l.add(name);
        localStorage.setItem(k, modBase64String);
        localStorage.setItem(this.modDataLocalStorageZipList, JSON.stringify(Array.from(l)));
    }

    setConfigKey(
        modDataLocalStorageZipListKey?: string,
        modDataLocalStorageZipPrefix?: string,
    ) {
        LocalStorageLoader.modDataLocalStorageZipList = modDataLocalStorageZipListKey ?? LocalStorageLoader.modDataLocalStorageZipList;
        LocalStorageLoader.modDataLocalStorageZipPrefix = modDataLocalStorageZipPrefix ?? LocalStorageLoader.modDataLocalStorageZipPrefix;
    }
}

async function loadStringList(key: string, db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)): Promise<string[] | undefined> {
    const raw = await keyval_get(key, db);
    if (!raw) return undefined;
    try {
        const value = JSON5.parse(raw);
        if (isStringArray(value)) return value;
    } catch (e) {
        console.error(e);
    }
    return undefined;
}

async function saveStringList(key: string, modeList: string[], db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)): Promise<void> {
    if (!isStringArray(modeList)) {
        console.error('ModLoader ====== IndexDBLoader saveStringList() modeList type invalid.');
        return;
    }
    await keyval_set(key, JSON.stringify([...new Set(modeList)]), db);
}

async function loadStringRecord(key: string, db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)): Promise<Record<string, string>> {
    const raw = await keyval_get(key, db);
    if (!raw) return {};
    try {
        const record = JSON5.parse(raw);
        if (isPlainObject(record) && Object.values(record).every(isString)) {
            return record as Record<string, string>;
        }
    } catch (e) {
        console.error(e);
    }
    return {};
}


export class IndexDBLoader extends LoaderBase {

    /** All IndexedDB keys/options, renamed via LoaderKeyConfig in init(). */
    static K = {
        dbName: 'ModLoader_IndexDBLoader',
        storeName: 'ModLoader_IndexDBLoader',
        list: 'modDataIndexDBZipList',
        hidden: 'modDataIndexDBZipListHidden',
        readonly: 'modDataIndexDBZipListReadonly',
        pinned: 'modDataIndexDBZipPinned',
        bundledHash: 'modDataIndexDBZipBundledHash',
        prefix: 'modDataIndexDBZip',
        partSize: 1024 * 1024,
    };

    /** Names of K entries that LoaderKeyConfig may rename at runtime. */
    static K_RENAMABLE = ['dbName', 'storeName', 'list', 'hidden', 'readonly', 'pinned', 'bundledHash', 'prefix'] as const;

    override init() {
        super.init();
        const K = IndexDBLoader.K;
        for (const key of IndexDBLoader.K_RENAMABLE) {
            K[key] = this.loaderKeyConfig.getLoaderKey(String(K[key]), String(K[key]));
        }
        this.customStore = createStore(K.dbName, K.storeName);
    }

    customStore!: UseStore;

    constructor(
        public modLoadControllerCallback: ModLoadControllerCallback,
        public loaderKeyConfig: LoaderKeyConfig,
    ) {
        super(modLoadControllerCallback, loaderKeyConfig);
    }

    async load(): Promise<boolean> {

        const listFile = await keyval_get(IndexDBLoader.K.list, this.customStore);
        if (!listFile) {
            return false;
        }
        let list: string[];
        try {
            list = JSON5.parse(listFile);
        } catch (e) {
            console.error(e);
            return false;
        }
        if (!isStringArray(list)) {
            return false;
        }


        // modDataBase64ZipStringList: base64[] | Uint8Array[]
        const capacity = runtimeCapacity().modPrefetch;
        const pending = new Map<number, Promise<ModZipData | undefined>>();
        const schedule = (index: number) => {
            if (index < list.length) pending.set(index, IndexDBLoader.getModData(list[index], this.customStore));
        };
        for (let index = 0; index < capacity; index++) schedule(index);
        for (let index = 0; index < list.length; index++) {
            const zipPath = list[index];
            const modZipData = await pending.get(index);
            pending.delete(index);
            if (!modZipData) {
                console.error('ModLoader ====== IndexDBLoader load() cannot get zipPath:', zipPath);
            } else {
                await this.initZipReader(modZipData, isString(modZipData) ? {base64: true} : undefined);
            }
            schedule(index + capacity);
            await yieldToMainThread();
        }

        return true;
    }

    /**
     * @param modeList must have same items as the list in listMod()
     */
    static async reorderModList(modeList: string[]) {
        const oldList = await IndexDBLoader.listMod();
        if (!oldList || oldList.length !== modeList.length || !oldList.every(T => modeList.includes(T))) {
            console.error('ModLoader ====== IndexDBLoader reorderModList() modeList must be a permutation of the stored list');
            return;
        }
        await saveStringList(IndexDBLoader.K.list, modeList);
    }

    static async setModList(modeList: string[]) {
        await saveStringList(IndexDBLoader.K.list, modeList);
    }

    static async setHiddenModList(modeList: string[]) {
        await saveStringList(IndexDBLoader.K.hidden, modeList);
    }

    static async setReadonlyModList(modeList: string[]) {
        await saveStringList(IndexDBLoader.K.readonly, modeList);
    }

    static async loadReadonlyModList() {
        return loadStringList(IndexDBLoader.K.readonly);
    }

    static async loadPinnedModList(db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)): Promise<string[] | undefined> {
        return loadStringList(IndexDBLoader.K.pinned, db);
    }

    static async setPinnedModList(modeList: string[], db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)) {
        await saveStringList(IndexDBLoader.K.pinned, modeList, db);
    }

    static async addPinnedMod(name: string, db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)) {
        const pinnedList = await this.loadPinnedModList(db) || [];
        if (!pinnedList.includes(name)) await this.setPinnedModList([...pinnedList, name], db);
    }

    static async removePinnedMod(name: string, db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)) {
        const pinnedList = await this.loadPinnedModList(db) || [];
        await this.setPinnedModList(pinnedList.filter(T => T !== name), db);
    }

    static async isPinnedMod(name: string, db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)): Promise<boolean> {
        return (await this.loadPinnedModList(db) || []).includes(name);
    }

    static async loadBundledHashMap(db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)): Promise<Record<string, string>> {
        return loadStringRecord(IndexDBLoader.K.bundledHash, db);
    }

    static async syncBundledModList() {
        const bundledList = (window as any).modDataValueZipListIndexDB;
        if (!bundledList) return;
        if (!Array.isArray(bundledList)) {
            console.error('ModLoader ====== IndexDBLoader syncBundledModList() bundledList invalid.');
            return;
        }
        try {
            const db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName);
            const enabledSet = new Set(await this.listMod() || []);
            const hiddenSet = new Set(await this.loadHiddenModList() || []);
            const readonlySet = new Set<string>();
            const hashMap = await this.loadBundledHashMap(db);
            const currentBundledSet = new Set<string>();
            const pinnedSet = new Set(await this.loadPinnedModList(db) || []);

            for (const item of bundledList) {
                const bundledItem = isString(item) ? undefined : item as IndexDBBundledModItem;
                const data = isString(item) ? item : bundledItem?.data;
                const maybeDataParts = bundledItem?.dataParts;
                const dataParts = isStringArray(maybeDataParts) ? maybeDataParts : undefined;
                if (!isString(data) && !dataParts) {
                    console.error('ModLoader ====== IndexDBLoader syncBundledModList() item data invalid.', item);
                    continue;
                }
                const maybeName = bundledItem?.name;
                const maybeHash = bundledItem?.hash;
                const isBuiltin = bundledItem?.builtin === true;
                const itemName = isString(maybeName) ? maybeName : '';
                const hash = isString(maybeHash) ? maybeHash : '';
                if (isBuiltin && itemName) currentBundledSet.add(itemName);

                if (itemName && hash && (hashMap[itemName] === hash || pinnedSet.has(itemName))) {
                    readonlySet.add(itemName);
                    if (await this.getModData(itemName, db)) {
                        if (!enabledSet.has(itemName) && !hiddenSet.has(itemName)) enabledSet.add(itemName);
                        if (bundledItem?.dataParts) bundledItem.dataParts.length = 0;
                        if (bundledItem?.data) bundledItem.data = '';
                        continue;
                    }
                }

                if (itemName && hash && dataParts) {
                    readonlySet.add(itemName);
                    await this.modDataFromBase64Parts(itemName, dataParts, db);
                    dataParts.length = 0;
                    hashMap[itemName] = hash;
                    if (!enabledSet.has(itemName) && !hiddenSet.has(itemName)) enabledSet.add(itemName);
                    continue;
                }
                if (itemName && hash && data) {
                    readonlySet.add(itemName);
                    await this.setModData(itemName, data, db);
                    bundledItem!.data = '';
                    hashMap[itemName] = hash;
                    if (!enabledSet.has(itemName) && !hiddenSet.has(itemName)) enabledSet.add(itemName);
                    continue;
                }
                if (!data) {
                    console.error('ModLoader ====== IndexDBLoader syncBundledModList() item cannot fallback check without data.', item);
                    continue;
                }

                const bootJson = await this.checkModZipFile(data).catch(e => {
                    console.error('ModLoader ====== IndexDBLoader syncBundledModList() checkModZipFile error.', e);
                    return undefined;
                });
                if (!bootJson || isString(bootJson)) {
                    console.error('ModLoader ====== IndexDBLoader syncBundledModList() bootJson invalid.', bootJson);
                    continue;
                }
                const name = bootJson.name;
                readonlySet.add(name);
                const oldData = await this.getModData(name, db);
                if (!oldData || (hash && hashMap[name] !== hash)) {
                    await this.setModData(name, data, db);
                    if (hash) hashMap[name] = hash;
                }
                if (!enabledSet.has(name) && !hiddenSet.has(name)) enabledSet.add(name);
            }

            for (const name of Object.keys(hashMap)) {
                if (currentBundledSet.has(name)) continue;
                if (pinnedSet.has(name)) continue;
                enabledSet.delete(name);
                hiddenSet.delete(name);
                readonlySet.delete(name);
                await this.delModData(name, db);
                delete hashMap[name];
            }

            await keyval_set(IndexDBLoader.K.list, JSON.stringify(Array.from(enabledSet)), db);
            await keyval_set(IndexDBLoader.K.hidden, JSON.stringify(Array.from(hiddenSet)), db);
            await keyval_set(IndexDBLoader.K.readonly, JSON.stringify(Array.from(readonlySet)), db);
            await keyval_set(IndexDBLoader.K.bundledHash, JSON.stringify(hashMap), db);
        } finally {
            delete (window as any).modDataValueZipListIndexDB;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    static async loadHiddenModList() {
        return loadStringList(IndexDBLoader.K.hidden);
    }

    static async listMod() {
        return loadStringList(IndexDBLoader.K.list);
    }

    static calcModNameKey(name: string) {
        return `${IndexDBLoader.K.prefix}:${name}`;
    }

    static calcModPartKey(name: string, partKey: string, index: number) {
        return `${this.calcModNameKey(name)}:part:${partKey}:${index}`;
    }

    static makeModPartKey() {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    static getModPartSize(byteLength: number) {
        const baseSize = IndexDBLoader.K.partSize;
        if (byteLength <= baseSize) {
            return baseSize;
        }
        const maxPartCount = byteLength > 256 * baseSize ? 128 : 64;
        const expectedSize = Math.ceil(byteLength / maxPartCount);
        return Math.max(baseSize, Math.ceil(expectedSize / baseSize) * baseSize);
    }

    static isModPartsRecord(value: any): value is IndexDBModPartsRecord {
        return Array.isArray(value)
            && value.length === 4
            && typeof value[0] === 'number'
            && typeof value[1] === 'number'
            && typeof value[2] === 'number'
            && isString(value[3]);
    }

    static async deleteModParts(name: string, record: IndexDBModPartsRecord, db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)) {
        const [, partCount, , partKey] = record;
        const partKeys = Array.from({ length: partCount }, (_, i) => this.calcModPartKey(name, partKey, i));
        await Promise.all(partKeys.map(partKeyName => keyval_del(partKeyName, db)));
    }

    static async getModData(name: string, db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)): Promise<ModZipData | undefined> {
        const value = await keyval_get(this.calcModNameKey(name), db);
        if (!this.isModPartsRecord(value)) {
            return value;
        }
        const [, partCount, byteLength, partKey] = value;
        const partKeys = Array.from({ length: partCount }, (_, i) => this.calcModPartKey(name, partKey, i));
        const parts = await Promise.all(partKeys.map(partKeyName => keyval_get(partKeyName, db)));
        const result = new Uint8Array(byteLength);
        let offset = 0;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!(part instanceof Uint8Array)) {
                console.error('ModLoader ====== IndexDBLoader getModData() part invalid:', [name, i]);
                return undefined;
            }
            result.set(part, offset);
            offset += part.length;
        }
        return result;
    }

    static async setModData(name: string, modData: ModZipData, db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)) {
        const k = this.calcModNameKey(name);
        const oldValue = await keyval_get(k, db);
        const modBin = isString(modData) ? base64ToUint8Array(modData) : modData;
        const partSize = this.getModPartSize(modBin.length);
        if (modBin.length <= partSize) {
            await keyval_set(k, modBin, db);
            if (this.isModPartsRecord(oldValue)) {
                await this.deleteModParts(name, oldValue, db);
            }
            return;
        }
        const partCount = Math.ceil(modBin.length / partSize);
        const partKey = this.makeModPartKey();
        const partWrites: [string, Uint8Array][] = [];
        for (let i = 0; i < partCount; i++) {
            const start = i * partSize;
            const end = Math.min(start + partSize, modBin.length);
            partWrites.push([this.calcModPartKey(name, partKey, i), modBin.slice(start, end)]);
        }
        await Promise.all(partWrites.map(([key, part]) => keyval_set(key, part, db)));
        const record: IndexDBModPartsRecord = [partSize, partCount, modBin.length, partKey];
        await keyval_set(k, record, db);
        if (this.isModPartsRecord(oldValue)) {
            await this.deleteModParts(name, oldValue, db);
        }
    }

    static async modDataFromBase64Parts(name: string, dataParts: string[], db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)) {
        const k = this.calcModNameKey(name);
        const oldValue = await keyval_get(k, db);
        if (dataParts.length === 1) {
            await keyval_set(k, base64ToUint8Array(dataParts[0]), db);
            if (this.isModPartsRecord(oldValue)) {
                await this.deleteModParts(name, oldValue, db);
            }
            return;
        }
        const partKey = this.makeModPartKey();
        let byteLength = 0;
        let firstPartLength = 0;
        const partWrites: [string, Uint8Array][] = [];
        for (let i = 0; i < dataParts.length; i++) {
            const part = base64ToUint8Array(dataParts[i]);
            if (i === 0) firstPartLength = part.length;
            byteLength += part.length;
            partWrites.push([this.calcModPartKey(name, partKey, i), part]);
        }
        await Promise.all(partWrites.map(([key, part]) => keyval_set(key, part, db)));
        const record: IndexDBModPartsRecord = [firstPartLength, dataParts.length, byteLength, partKey];
        await keyval_set(k, record, db);
        if (this.isModPartsRecord(oldValue)) {
            await this.deleteModParts(name, oldValue, db);
        }
    }

    static async delModData(name: string, db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName)) {
        const k = this.calcModNameKey(name);
        const oldValue = await keyval_get(k, db);
        if (this.isModPartsRecord(oldValue)) {
            await this.deleteModParts(name, oldValue, db);
        }
        await keyval_del(k, db);
    }

    static async addMod(name: string, modBase64String: string | Uint8Array) {
        const l = new Set(await this.listMod() || []);
        l.add(name);
        const db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName);
        await this.setModData(name, modBase64String, db);
        await keyval_set(IndexDBLoader.K.list, JSON.stringify(Array.from(l)), db);
        // importing over a bundled (readonly / hash-tracked) mod pins the user's override so
        // syncBundledModList keeps it instead of reverting to the embedded default on next boot.
        const readonlyList = await this.loadReadonlyModList() || [];
        const bundledHash = await this.loadBundledHashMap(db);
        if (readonlyList.includes(name) || bundledHash[name]) {
            await this.addPinnedMod(name, db);
        }
    }

    // Drop a user's imported override of a bundled mod: unpin, delete data and the stored
    // bundled hash so the next syncBundledModList re-imports the embedded default version.
    static async resetBundledModToDefault(name: string) {
        const db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName);
        await this.removePinnedMod(name, db);
        await this.delModData(name, db);
        const hashMap = await this.loadBundledHashMap(db);
        if (hashMap[name]) {
            delete hashMap[name];
            await keyval_set(IndexDBLoader.K.bundledHash, JSON.stringify(hashMap), db);
        }
    }

    static async removeMod(name: string) {
        if ((await this.loadReadonlyModList() || []).includes(name)) {
            console.warn('ModLoader ====== IndexDBLoader removeMod() readonly mod cannot remove:', name);
            return false;
        }
        let l = await this.listMod() || [];
        l = l.filter(T => T !== name);
        let lH = await this.loadHiddenModList() || [];
        lH = lH.filter(T => T !== name);
        const db = createStore(IndexDBLoader.K.dbName, IndexDBLoader.K.storeName);
        await keyval_set(IndexDBLoader.K.list, JSON.stringify(l), db);
        await keyval_set(IndexDBLoader.K.hidden, JSON.stringify(lH), db);
        await this.delModData(name, db);
        return true;
    }

    static async checkModZipFile(modData: ModZipData) {
        return modBootJson(modData);
    }

    setConfigKey(
        dbName?: string,
        storeName?: string,
        modDataIndexDBZipList?: string,
        modDataIndexDBZipListHidden?: string,
    ) {
        IndexDBLoader.K.dbName = dbName ?? IndexDBLoader.K.dbName;
        IndexDBLoader.K.storeName = storeName ?? IndexDBLoader.K.storeName;
        IndexDBLoader.K.list = modDataIndexDBZipList ?? IndexDBLoader.K.list;
        IndexDBLoader.K.hidden = modDataIndexDBZipListHidden ?? IndexDBLoader.K.hidden;
    }

}

export class Base64ZipStringLoader extends LoaderBase {

    constructor(
        public modLoadControllerCallback: ModLoadControllerCallback,
        public loaderKeyConfig: LoaderKeyConfig,
        // base64ZipStringList: base64[]
        public base64ZipStringList: string[],
    ) {
        super(modLoadControllerCallback, loaderKeyConfig);
    }

    async load(): Promise<boolean> {

        // modDataBase64ZipStringList: base64[]
        for (const base64ZipString of this.base64ZipStringList) {
            await this.initZipReader(base64ZipString, {base64: true});
        }

        return true;
    }

}

export class LocalLoader extends LoaderBase {
    modDataValueZipListPath = 'modDataValueZipList';

    override init() {
        super.init();
        this.modDataValueZipListPath = this.loaderKeyConfig.getLoaderKey(this.modDataValueZipListPath, this.modDataValueZipListPath);
    }

    constructor(
        public modLoadControllerCallback: ModLoadControllerCallback,
        public loaderKeyConfig: LoaderKeyConfig,
        public thisWin: Window,
    ) {
        super(modLoadControllerCallback, loaderKeyConfig);
    }


    async load(): Promise<boolean> {
        if ((this.thisWin as any)[this.modDataValueZipListPath]) {

            const modDataValueZipList: undefined | string[] = (this.thisWin as any)[this.modDataValueZipListPath];
            if (isStringArray(modDataValueZipList)) {

                // modDataValueZipList: base64[]
                for (const modDataValueZip of modDataValueZipList) {
                    await this.initZipReader(modDataValueZip, {base64: true});
                }

                return true;
            }
        }
        return false;
    }

    setConfigKey(modDataValueZipListPath?: string) {
        this.modDataValueZipListPath = modDataValueZipListPath ?? this.modDataValueZipListPath;
    }

}

export class RemoteLoader extends LoaderBase {

    modDataRemoteListPath = 'modList.json';

    override init() {
        super.init();
        this.modDataRemoteListPath = this.loaderKeyConfig.getLoaderKey(this.modDataRemoteListPath, this.modDataRemoteListPath);
    }

    async load(): Promise<boolean> {
        const modList: undefined | string[] = await fetch(this.modDataRemoteListPath).then(T => T.json()).catch(E => {
            console.error(E);
            return undefined;
        });
        console.log('ModLoader ====== RemoteLoader load() modList', modList);

        if (isStringArray(modList)) {

            // modList: filePath[]
            for (const modFileZipPath of modList) {
                try {
                    const blob = await fetch(modFileZipPath).then(T => T.blob());
                    await this.initZipReader(blob);
                } catch (E) {
                    console.error(E);
                }
            }

            return true;
        }
        return false;
    }

    setConfigKey(modDataRemoteListPath: string) {
        this.modDataRemoteListPath = modDataRemoteListPath;
    }

}

export class LazyLoader extends LoaderBase {

    async add(modeZip: JSZipLikeReadOnlyInterface) {
        try {
            if (modeZip.is_JeremieModLoader_ModPack) {
                const m = new ModZipReader(modeZip, '', this, this.log);
                if (await m.init()) {
                    this.modList.push(m);
                }
                return m;
            }
            const base64ZipString = await modeZip.generateAsync!({type: "base64"});
            const m = new ModZipReader(modeZip, base64ZipString, this, this.log);
            if (await m.init()) {
                this.modList.push(m);
            }
            return m;
        } catch (E: Error | any) {
            console.error('LazyLoader add()', E);
            this.log.logError(`LazyLoader add() [${E?.message ? E.message : E}]`);
            throw E;
        }
    }

    async load(): Promise<boolean> {
        return true;
    }

}

export const getModZipReaderStaticClassRef = () => {
    console.error('WARNING: the [[[getModZipReaderStaticClassRef]]] will delete later.');
    return {
        LocalStorageLoader,
        IndexDBLoader,
        LocalLoader,
        RemoteLoader,
    };
};

export class LoaderKeyConfig {

    modLoaderKeyConfigWinHookFunctionName = 'modLoaderKeyConfigWinHookFunction';

    logger: Record<'log' | 'warn' | 'error', ((s: string) => void)>;

    constructor(
        public log: ModLoadControllerCallback,
    ) {
        this.logger = {
            log: (s: string) => {
                this.log.logInfo(s);
            },
            warn: (s: string) => {
                this.log.logWarning(s);
            },
            error: (s: string) => {
                this.log.logError(s);
            },
        }
    }

    config: Map<string, string> = new Map<string, string>();

    getLoaderKey(key: string, fallback: string) {
        this.init();
        const value = this.config.get(key);
        return value && value.length > 0 ? value : fallback;
    }

    protected isInit = false;

    protected init() {
        if (this.isInit) {
            return;
        }
        this.isInit = true;
        this.callWinHookFunction();
        this.getConfigFromUrlHash();
        if (this.config.size > 0) {
            this.logger.log(`LoaderKeyConfig init() config:[${[...this.config.entries()]}]`);
        }
    }

    /**
     * @example
     * @code
     * ```
     * window.modLoaderKeyConfigWinHookFunction = (loaderKeyConfig: LoaderKeyConfig) => {
     *    loaderKeyConfig.config.set('modDataIndexDBZipList', 'modDataIndexDBZipList123456789');
     * };
     * ```
     *
     * @protected
     */
    protected callWinHookFunction() {
        try {
            if ((window as any)[this.modLoaderKeyConfigWinHookFunctionName]) {
                (window as any)[this.modLoaderKeyConfigWinHookFunctionName](this);
            }
        } catch (e) {
            console.error('LoaderKeyConfig callWinHookFunction Error', e);
            this.logger.error('LoaderKeyConfig callWinHookFunction Error');
        }
    }

    /**
     * @example   URL:  ./Degrees of Lewdity VERSION.html.mod.html?modDataIndexDBZipList=modDataIndexDBZipList123456789
     * @protected
     */
    protected getConfigFromUrlHash() {
        for (const [key, value] of new URLSearchParams(window.location.search)) {
            this.config.set(key, value);
        }
    }

}

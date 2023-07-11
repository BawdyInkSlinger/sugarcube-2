/***********************************************************************************************************************

	save.js

	Copyright © 2013–2023 Thomas Michael Edwards <thomasmedwards@gmail.com>. All rights reserved.
	Use of this source code is governed by a BSD 2-clause "Simplified" License, which may be found in the LICENSE file.

***********************************************************************************************************************/
/* global Config, L10n, Serial, State, createFilename, enumFrom, getTypeOf, storage */

/*
	Save API static object.
*/
var Save = (() => { // eslint-disable-line no-unused-vars, no-var
	// Save type pseudo-enumeration.
	const Type = enumFrom({
		Auto   : 'auto',
		Base64 : 'base64',
		Disk   : 'disk',
		Slot   : 'slot',

		/* legacy */
		// Duplicate `Base64`.
		Serialize : 'base64' // Originally: `'serialize'`
		/* /legacy */
	});

	// Save index maximum value constant (`0`-based).
	const MAX_INDEX = 15;

	// Browser save key constants.
	const INDEX_DELIMITER  = ':';
	const SAVE_SUBKEY      = 'save.';
	const AUTO_SUBKEY      = `${SAVE_SUBKEY}auto.`;
	const AUTO_DATA_SUBKEY = `${AUTO_SUBKEY}data${INDEX_DELIMITER}`;
	const AUTO_INFO_SUBKEY = `${AUTO_SUBKEY}info${INDEX_DELIMITER}`;
	const SLOT_SUBKEY      = `${SAVE_SUBKEY}slot.`;
	const SLOT_DATA_SUBKEY = `${SLOT_SUBKEY}data${INDEX_DELIMITER}`;
	const SLOT_INFO_SUBKEY = `${SLOT_SUBKEY}info${INDEX_DELIMITER}`;

	// Save handler sets.
	const onLoadHandlers = new Set();
	const onSaveHandlers = new Set();


	/*******************************************************************************
		Initialization Functions.
	*******************************************************************************/

	/*
		Initialize the saves subsystem.
	*/
	function init() {
		if (BUILD_DEBUG) { console.log('[Save/init()]'); }

		// Migrate browser saves from the old monolithic v2 save object
		// to the new v3 style with separate entries for each save.
		migrateV2BrowserSaves();

		return true;
	}

	function migrateV2BrowserSaves() {
		const oldSaves = storage.get('saves');

		// Bail out if no old saves object exists.
		if (oldSaves === null) {
			return;
		}

		// Delete existing saves before storing the migrated saves.
		autoClear();
		slotClear();

		// Old monolithic saves object:
		// 	{
		// 		autosave : save | null,
		// 		slots    : Array<save | null>
		// 	}
		//
		// Old auto & slot save objects:
		// 	{
		// 		title    : description,
		// 		date     : unix_datestamp,
		// 		metadata : metadata | undefined,
		// 		id       : id,
		// 		state    : state,
		// 		version  : version | undefined
		// 	}

		// Migrate the auto save.
		if (oldSaves.autosave) {
			const { info, data } = splitSave(oldSaves.autosave);

			// Property updates.
			info.desc = info.title;
			delete info.title;

			const infoKey = getAutoInfoKeyFromIdx(0);
			const dataKey = getAutoDataKeyFromIdx(0);

			// If storing either chunk is going to fail, it's more likely
			// to be the data chunk, so we attempt to store it first.
			if (storage.set(dataKey, data)) {
				if (!storage.set(infoKey, info)) {
					storage.delete(dataKey);
				}
			}
		}

		// Migrate the slot saves.
		oldSaves.slots.forEach((save, idx) => {
			if (!save) {
				return;
			}

			const { info, data } = splitSave(save);

			// Property updates.
			info.desc = info.title;
			delete info.title;

			const infoKey = getSlotInfoKeyFromIdx(idx);
			const dataKey = getSlotDataKeyFromIdx(idx);

			// If storing either chunk is going to fail, it's more likely
			// to be the data chunk, so we attempt to store it first.
			if (storage.set(dataKey, data)) {
				if (!storage.set(infoKey, info)) {
					storage.delete(dataKey);
				}
			}
		});

		// Delete the old saves object.
		storage.delete('saves');
	}


	/*******************************************************************************
		Saves Utility Functions.
	*******************************************************************************/

	function createDatestamp(date) {
		if (!(date instanceof Date)) {
			throw new TypeError('createDatestamp date parameter must be a Date object');
		}

		let MM = date.getMonth() + 1;
		let DD = date.getDate();
		let hh = date.getHours();
		let mm = date.getMinutes();
		let ss = date.getSeconds();

		if (MM < 10) { MM = `0${MM}`; }
		if (DD < 10) { DD = `0${DD}`; }
		if (hh < 10) { hh = `0${hh}`; }
		if (mm < 10) { mm = `0${mm}`; }
		if (ss < 10) { ss = `0${ss}`; }

		return `${date.getFullYear()}${MM}${DD}-${hh}${mm}${ss}`;
	}

	function createDetails(saveType, description, metadata) {
		const metadataType = typeof metadata;

		if (metadataType !== 'object' && metadataType !== 'undefined') {
			throw new TypeError('metadata parameter must be an object or null/undefined');
		}

		const cfgMetadata     = Config.saves.metadata ? Config.saves.metadata(saveType) : undefined;
		const cfgMetadataType = typeof cfgMetadata;

		if (cfgMetadataType !== 'object' && cfgMetadataType !== 'undefined') {
			throw new TypeError('Config.saves.metadata function must return an object or null/undefined');
		}

		const details = { type : saveType };
		let desc;

		if (description != null) { // lazy equality for null
			desc = String(description).trim();
		}

		if (!desc && typeof Config.saves.descriptions === 'function') {
			desc = String(Config.saves.descriptions(saveType)).trim();
		}

		details.desc = desc || `${L10n.get('turn')} ${State.turns}`;

		const fullMetadata = Object.assign({}, cfgMetadata, metadata);

		if (Object.keys(fullMetadata).length > 0) {
			details.metadata = fullMetadata;
		}

		return details;
	}

	// Find the most recent index, ordered by date (descending).
	function findNewest(saveType) {
		let keys;

		switch (saveType) {
			case Type.Auto: keys = getKeys(isAutoInfoKey); break;
			case Type.Slot: keys = getKeys(isSlotInfoKey); break;
			default:        keys = getKeys(isInfoKey); break;
		}

		switch (keys.length) {
			case 0: return { idx : -1 };
			case 1: return {
				idx  : getIdxFromKey(keys[0]),
				type : getTypeFromKey(keys[0])
			};
		}

		return keys
			.map(key => ({
				value : {
					idx  : getIdxFromKey(key),
					type : getTypeFromKey(key)
				},
				date : storage.get(key).date
			}))
			.sort((a, b) => b.date - a.date)
			.first()
			.value;
	}

	function getIdxFromKey(key) {
		const pos = key.lastIndexOf(INDEX_DELIMITER);

		if (pos === -1) {
			throw new Error(`unable to get index from save key (received: ${key})`);
		}

		return Number(key.slice(pos + 1));
	}

	function getAutoInfoKeyFromIdx(idx) {
		return `${AUTO_INFO_SUBKEY}${idx}`;
	}

	function getAutoDataKeyFromIdx(idx) {
		return `${AUTO_DATA_SUBKEY}${idx}`;
	}

	function getSlotInfoKeyFromIdx(idx) {
		return `${SLOT_INFO_SUBKEY}${idx}`;
	}

	function getSlotDataKeyFromIdx(idx) {
		return `${SLOT_DATA_SUBKEY}${idx}`;
	}

	function getKeys(predicate) {
		return storage.keys().filter(predicate);
	}

	function getTypeFromKey(key) {
		return isAutoKey(key) ? Type.Auto : Type.Slot;
	}

	function isInfoKey(key) {
		return key.startsWith(AUTO_INFO_SUBKEY) || key.startsWith(SLOT_INFO_SUBKEY);
	}

	function isAutoKey(key) {
		return key.startsWith(AUTO_SUBKEY);
	}

	function isAutoInfoKey(key) {
		return key.startsWith(AUTO_INFO_SUBKEY);
	}

	function isSlotKey(key) {
		return key.startsWith(SLOT_SUBKEY);
	}

	function isSlotInfoKey(key) {
		return key.startsWith(SLOT_INFO_SUBKEY);
	}

	function saveBlobToDiskAs(data, filename, extension) {
		if (typeof filename !== 'string') {
			throw new Error('filename parameter must be a string');
		}

		const baseName = createFilename(filename);

		if (baseName === '') {
			throw new Error('filename parameter must not consist solely of illegal characters');
		}

		const datestamp = createDatestamp(new Date());
		const fileExt   = createFilename(extension) || 'save';

		saveAs(
			new Blob([data], { type : 'text/plain;charset=UTF-8' }),
			`${baseName}-${datestamp}.${fileExt}`
		);
	}


	/*******************************************************************************
		Browser Auto Saves Functions.
	*******************************************************************************/

	function autoClear() {
		getKeys(isAutoKey).forEach(key => storage.delete(key));
		return true;
	}

	function autoDelete(idx) {
		if (!Number.isInteger(idx)) {
			throw new TypeError('auto save index must be an integer');
		}

		if (idx < 0 || idx > MAX_INDEX) {
			throw new RangeError(`auto save index out of bounds (range: 0–${MAX_INDEX}; received: ${idx})`);
		}

		storage.delete(getAutoInfoKeyFromIdx(idx));
		storage.delete(getAutoDataKeyFromIdx(idx));
		return true;
	}

	function autoEntries() {
		// NOTE: Order by date (descending).
		return getKeys(isAutoInfoKey)
			.map(key => ({
				idx  : getIdxFromKey(key),
				info : storage.get(key)
			}))
			.sort((a, b) => b.info.date - a.info.date);
	}

	function autoGet(idx) {
		if (!Number.isInteger(idx)) {
			throw new TypeError('auto save index must be an integer');
		}

		if (idx < 0 || idx > MAX_INDEX) {
			throw new RangeError(`auto save index out of bounds (range: 0–${MAX_INDEX}; received: ${idx})`);
		}

		return storage.get(getAutoInfoKeyFromIdx(idx));
	}

	function autoHas(idx) {
		if (!Number.isInteger(idx)) {
			throw new TypeError('auto save index must be an integer');
		}

		if (idx < 0 || idx > MAX_INDEX) {
			throw new RangeError(`auto save index out of bounds (range: 0–${MAX_INDEX}; received: ${idx})`);
		}

		return storage.has(getAutoInfoKeyFromIdx(idx));
	}

	function autoIsEnabled() {
		return storage.name !== 'cookie' && Config.saves.maxAutoSaves > 0;
	}

	function autoLoad(idx) {
		return new Promise(resolve => {
			if (!Number.isInteger(idx)) {
				throw new TypeError('auto save index must be an integer');
			}

			if (idx < 0 || idx > MAX_INDEX) {
				throw new RangeError(`auto save index out of bounds (range: 0–${MAX_INDEX}; received: ${idx})`);
			}

			const info = storage.get(getAutoInfoKeyFromIdx(idx));
			const data = storage.get(getAutoDataKeyFromIdx(idx));

			if (!info || !data) {
				throw new Error(L10n.get('saveErrorNonexistent'));
			}

			// NOTE: May throw exceptions.
			unmarshal(Object.assign(info, data));

			resolve(true);
		});
	}

	function autoSave(desc, metadata) {
		if (
			!autoIsEnabled()
			|| typeof Config.saves.isAllowed === 'function'
			&& !Config.saves.isAllowed(Type.Auto)
		) {
			return false;
		}

		const details        = createDetails(Type.Auto, desc, metadata);
		const idx            = (findNewest(Type.Auto).idx + 1) % Config.saves.maxAutoSaves;
		const { info, data } = splitSave(marshal(details));
		const infoKey        = getAutoInfoKeyFromIdx(idx);
		const dataKey        = getAutoDataKeyFromIdx(idx);

		// If storing either chunk is going to fail, it's more likely
		// to be the data chunk, so we attempt to store it first.
		if (storage.set(dataKey, data)) {
			if (!storage.set(infoKey, info)) {
				storage.delete(dataKey);
				return false;
			}
		}

		return true;
	}

	function autoSize() {
		return getKeys(isAutoInfoKey).length;
	}


	/*******************************************************************************
		Browser Slot Saves Functions.
	*******************************************************************************/

	function slotClear() {
		getKeys(isSlotKey).forEach(key => storage.delete(key));
		return true;
	}

	function slotDelete(idx) {
		if (!Number.isInteger(idx)) {
			throw new TypeError('slot save index must be an integer');
		}

		if (idx < 0 || idx > MAX_INDEX) {
			throw new RangeError(`slot save index out of bounds (range: 0–${MAX_INDEX}; received: ${idx})`);
		}

		storage.delete(getSlotInfoKeyFromIdx(idx));
		storage.delete(getSlotDataKeyFromIdx(idx));
		return true;
	}

	function slotEntries() {
		// NOTE: Order by ID (ascending).
		return getKeys(isSlotInfoKey)
			.map(key => ({
				idx  : getIdxFromKey(key),
				info : storage.get(key)
			}))
			.sort((a, b) => a.idx - b.idx);
	}

	function slotGet(idx) {
		if (!Number.isInteger(idx)) {
			throw new TypeError('slot save index must be an integer');
		}

		if (idx < 0 || idx > MAX_INDEX) {
			throw new RangeError(`slot save index out of bounds (range: 0–${MAX_INDEX}; received: ${idx})`);
		}

		return storage.get(getSlotInfoKeyFromIdx(idx));
	}

	function slotHas(idx) {
		if (!Number.isInteger(idx)) {
			throw new TypeError('slot save index must be an integer');
		}

		if (idx < 0 || idx > MAX_INDEX) {
			throw new RangeError(`slot save index out of bounds (range: 0–${MAX_INDEX}; received: ${idx})`);
		}

		return storage.has(getSlotInfoKeyFromIdx(idx));
	}

	function slotIsEnabled() {
		return storage.name !== 'cookie' && Config.saves.maxSlotSaves > 0;
	}

	function slotLoad(idx) {
		return new Promise(resolve => {
			if (!Number.isInteger(idx)) {
				throw new TypeError('slot save index must be an integer');
			}

			if (idx < 0 || idx > MAX_INDEX) {
				throw new RangeError(`slot save index out of bounds (range: 0–${MAX_INDEX}; received: ${idx})`);
			}

			const info = storage.get(getSlotInfoKeyFromIdx(idx));
			const data = storage.get(getSlotDataKeyFromIdx(idx));

			if (!info || !data) {
				throw new Error(L10n.get('saveErrorNonexistent'));
			}

			// NOTE: May throw exceptions.
			unmarshal(Object.assign(info, data));

			resolve(true);
		});
	}

	function slotSave(idx, desc, metadata) {
		if (!Number.isInteger(idx)) {
			throw new TypeError('slot save index must be an integer');
		}

		if (idx < 0 || idx >= Config.saves.maxSlotSaves) {
			throw new RangeError(`slot save index out of bounds (range: 0–${Config.saves.maxSlotSaves - 1}; received: ${idx})`);
		}

		if (
			!slotIsEnabled()
			|| typeof Config.saves.isAllowed === 'function'
			&& !Config.saves.isAllowed(Type.Slot)
		) {
			throw new Error(L10n.get('savesDisallowed'));
		}

		const details        = createDetails(Type.Slot, desc, metadata);
		const { info, data } = splitSave(marshal(details));
		const infoKey        = getSlotInfoKeyFromIdx(idx);
		const dataKey        = getSlotDataKeyFromIdx(idx);

		// If storing either chunk is going to fail, it's more likely
		// to be the data chunk, so we attempt to store it first.
		if (storage.set(dataKey, data)) {
			if (!storage.set(infoKey, info)) {
				storage.delete(dataKey);
				return false;
			}
		}

		return true;
	}

	function slotSize() {
		return  getKeys(isSlotInfoKey).length;
	}


	/*******************************************************************************
		Browser General Saves Functions.
	*******************************************************************************/

	function browserClear() {
		autoClear();
		slotClear();
		return true;
	}

	function browserContinue() {
		const newest = findNewest();

		if (newest.idx === -1) {
			return Promise.reject(new Error(L10n.get('saveErrorNonexistent')));
		}

		return newest.type === Type.Auto
			? autoLoad(newest.idx)
			: slotLoad(newest.idx);
	}

	function browserExport(filename) {
		if (filename == null) { // lazy equality for null
			throw new Error('Save.browser.export filename parameter is required');
		}

		const auto = getKeys(isAutoInfoKey).map(infoKey => {
			const idx  = getIdxFromKey(infoKey);
			const info = storage.get(infoKey);
			const data = storage.get(getAutoDataKeyFromIdx(idx));

			if (!info || !data) {
				throw new Error('during saves export auto save info or data nonexistent');
			}

			return { idx, info, data };
		});
		const slot = getKeys(isSlotInfoKey).map(infoKey => {
			const idx  = getIdxFromKey(infoKey);
			const info = storage.get(infoKey);
			const data = storage.get(getSlotDataKeyFromIdx(idx));

			if (!info || !data) {
				throw new Error('during saves export slot save info or data nonexistent');
			}

			return { idx, info, data };
		});

		saveBlobToDiskAs(
			LZString.compressToBase64(Serial.stringify({ auto, slot })),
			filename,
			'savesexport'
		);
	}

	function browserImport(event) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();

			// Add the handler that will capture the file data once the load is finished.
			jQuery(reader).on('loadend', () => {
				try {
					if (reader.error) {
						throw new Error(`${L10n.get('saveErrorDiskLoadFail')}: ${reader.error}`);
						// throw reader.error;
					}

					const badSave = O => !Object.hasOwn(O, 'idx')
						|| !Object.hasOwn(O, 'info')
						|| !Object.hasOwn(O, 'data');
					let bundle;

					try {
						bundle = Serial.parse(LZString.decompressFromBase64(reader.result));
					}
					catch (ex) {
						throw new Error(L10n.get('saveErrorDecodeFail'));
					}

					if (
						bundle == null // lazy equality for null
						|| typeof bundle !== 'object'
						|| !Object.hasOwn(bundle, 'auto')
						|| !(bundle.auto instanceof Array)
						|| bundle.auto.some(badSave)
						|| !Object.hasOwn(bundle, 'slot')
						|| !(bundle.slot instanceof Array)
						|| bundle.slot.some(badSave)
					) {
						throw new Error(L10n.get('saveErrorInvalidData'));
					}

					// Delete existing saves before storing the imports.
					autoClear();
					slotClear();

					// QUESTION: Should failures here throw exceptions?
					bundle.auto.forEach(save => {
						const { idx, info, data } = save;
						const infoKey             = getAutoInfoKeyFromIdx(idx);
						const dataKey             = getAutoDataKeyFromIdx(idx);

						// If storing either chunk is going to fail, it's more likely
						// to be the data chunk, so we attempt to store it first.
						if (storage.set(dataKey, data)) {
							if (!storage.set(infoKey, info)) {
								storage.delete(dataKey);
							}
						}
					});
					bundle.slot.forEach(save => {
						const { idx, info, data } = save;
						const infoKey             = getSlotInfoKeyFromIdx(idx);
						const dataKey             = getSlotDataKeyFromIdx(idx);

						// If storing either chunk is going to fail, it's more likely
						// to be the data chunk, so we attempt to store it first.
						if (storage.set(dataKey, data)) {
							if (!storage.set(infoKey, info)) {
								storage.delete(dataKey);
							}
						}
					});

					resolve(true);
				}
				catch (ex) {
					reject(ex);
				}
			});

			// Initiate the file load.
			reader.readAsText(event.target.files[0]);
		});
	}

	function browserIsEnabled() {
		return autoIsEnabled() || slotIsEnabled();
	}

	function browserSize() {
		return getKeys(isInfoKey).length;
	}


	/*******************************************************************************
		Disk Saves Functions.
	*******************************************************************************/

	function diskLoad(event) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();

			// Add the handler that will capture the file data once the load is finished.
			jQuery(reader).on('loadend', () => {
				try {
					if (reader.error) {
						throw new Error(`${L10n.get('saveErrorDiskLoadFail')}: ${reader.error}`);
						// throw reader.error;
					}

					let save;

					try {
						save = Serial.parse(LZString.decompressFromBase64(reader.result));
					}
					catch (ex) {
						throw new Error(L10n.get('saveErrorDecodeFail'));
					}

					// NOTE: May throw exceptions.
					unmarshal(save);

					resolve(save.metadata);
				}
				catch (ex) {
					reject(ex);
				}
			});

			// Initiate the file load.
			reader.readAsText(event.target.files[0]);
		});
	}

	function diskSave(filename, metadata) {
		if (filename == null) { // lazy equality for null
			throw new Error('Save.disk.save filename parameter is required');
		}

		if (
			typeof Config.saves.isAllowed === 'function'
			&& !Config.saves.isAllowed(Type.Disk)
		) {
			throw new Error(L10n.get('savesDisallowed'));
		}

		const details = createDetails(Type.Disk, filename, metadata);

		saveBlobToDiskAs(
			LZString.compressToBase64(Serial.stringify(marshal(details))),
			filename,
			'save'
		);
	}


	/*******************************************************************************
		Base64 Saves Functions.
	*******************************************************************************/

	function base64Load(base64) {
		return new Promise(resolve => {
			let save;

			try {
				save = Serial.parse(LZString.decompressFromBase64(base64));
			}
			catch (ex) {
				throw new Error(L10n.get('saveErrorDecodeFail'));
			}

			/* legacy */
			// Convert legacy `Type.Serialize` value to `Type.Base64`.
			if (save.type === 'serialize') {
				save.type = Type.Save.Base64;
			}
			/* /legacy */

			// NOTE: May throw exceptions.
			unmarshal(save);

			resolve(save.metadata);
		});
	}

	function base64Save(metadata) {
		if (
			typeof Config.saves.isAllowed === 'function'
			&& !Config.saves.isAllowed(Type.Base64)
		) {
			throw new Error(L10n.get('savesDisallowed'));
		}

		const details = createDetails(Type.Base64, null, metadata);

		return LZString.compressToBase64(Serial.stringify(marshal(details)));
	}


	/*******************************************************************************
		Marshaling Functions.
	*******************************************************************************/

	function marshal(details) {
		if (BUILD_DEBUG) { console.log(`[Save/marshal({ type : "${details.type}" })]`); }

		const save = Object.assign({}, details, {
			date  : Date.now(),
			id    : Config.saves.id,
			state : State.marshalForSave()
		});

		if (Config.saves.version != null) { // lazy equality for null
			save.version = Config.saves.version;
		}

		// Call any `onSave` handlers.
		onSaveHandlers.forEach(fn => fn(save));

		// Delta encode the state history and delete the non-encoded property.
		save.state.delta = State.deltaEncode(save.state.history);
		delete save.state.history;

		return save;
	}

	function splitSave(save) {
		const { state, ...info } = save;
		return { info, data : { state } };
	}

	function unmarshal(save) {
		if (BUILD_DEBUG) { console.log('[Save/unmarshal()]'); }

		if (
			save == null // lazy equality for null
			|| typeof save !== 'object'
			|| !Object.hasOwn(save, 'id')
			|| !Object.hasOwn(save, 'state')
			|| typeof save.state !== 'object'
			|| !Object.hasOwn(save.state, 'delta')
		) {
			throw new Error(L10n.get('saveErrorInvalidData'));
		}

		if (save.id !== Config.saves.id) {
			throw new Error(L10n.get('saveErrorIdMismatch'));
		}

		// Delta decode the state history and delete the encoded property.
		/* eslint-disable no-param-reassign */
		save.state.history = State.deltaDecode(save.state.delta);
		delete save.state.delta;
		/* eslint-enable no-param-reassign */

		// Call any `onLoad` handlers.
		onLoadHandlers.forEach(fn => fn(save));

		// Restore the state.
		//
		// NOTE: May throw exceptions.
		State.unmarshalForSave(save.state);
	}


	/*******************************************************************************
		Event Functions.
	*******************************************************************************/

	function onLoadAdd(handler) {
		const valueType = getTypeOf(handler);

		if (valueType !== 'function') {
			throw new TypeError(`Save.onLoad.add handler parameter must be a function (received: ${valueType})`);
		}

		onLoadHandlers.add(handler);
	}

	function onLoadClear() {
		onLoadHandlers.clear();
	}

	function onLoadDelete(handler) {
		return onLoadHandlers.delete(handler);
	}

	function onLoadSize() {
		return onLoadHandlers.size;
	}

	function onSaveAdd(handler) {
		const valueType = getTypeOf(handler);

		if (valueType !== 'function') {
			throw new TypeError(`Save.onSave.add handler parameter must be a function (received: ${valueType})`);
		}

		onSaveHandlers.add(handler);
	}

	function onSaveClear() {
		onSaveHandlers.clear();
	}

	function onSaveDelete(handler) {
		return onSaveHandlers.delete(handler);
	}

	function onSaveSize() {
		return onSaveHandlers.size;
	}


	/*******************************************************************************
		Object Exports.
	*******************************************************************************/

	return Object.preventExtensions(Object.create(null, {
		// General Save Constants.
		Type      : { value : Type },
		MAX_INDEX : { get : () => MAX_INDEX },

		// General Save Functions.
		init : { value : init },

		// Browser Saves Functions.
		browser : {
			value : Object.preventExtensions(Object.create(null, {
				// Browser Auto Saves Functions.
				auto : {
					value : Object.preventExtensions(Object.create(null, {
						clear     : { value : autoClear },
						delete    : { value : autoDelete },
						entries   : { value : autoEntries },
						get       : { value : autoGet },
						has       : { value : autoHas },
						isEnabled : { value : autoIsEnabled },
						load      : { value : autoLoad },
						save      : { value : autoSave },
						size      : { get : autoSize }
					}))
				},

				// Browser Slot Saves Functions.
				slot : {
					value : Object.preventExtensions(Object.create(null, {
						clear     : { value : slotClear },
						delete    : { value : slotDelete },
						entries   : { value : slotEntries },
						get       : { value : slotGet },
						has       : { value : slotHas },
						isEnabled : { value : slotIsEnabled },
						load      : { value : slotLoad },
						save      : { value : slotSave },
						size      : { get : slotSize }
					}))
				},

				// Browser General Saves Functions.
				clear     : { value : browserClear },
				continue  : { value : browserContinue },
				export    : { value : browserExport },
				import    : { value : browserImport },
				isEnabled : { value : browserIsEnabled },
				size      : { get : browserSize }
			}))
		},

		// Disk Saves Functions.
		disk : {
			value : Object.preventExtensions(Object.create(null, {
				load : { value : diskLoad },
				save : { value : diskSave }
			}))
		},

		// Base64 Saves Functions.
		base64 : {
			value : Object.preventExtensions(Object.create(null, {
				load : { value : base64Load },
				save : { value : base64Save }
			}))
		},

		// Event Functions.
		onLoad : {
			value : Object.preventExtensions(Object.create(null, {
				add    : { value : onLoadAdd },
				clear  : { value : onLoadClear },
				delete : { value : onLoadDelete },
				size   : { get : onLoadSize }
			}))
		},
		onSave : {
			value : Object.preventExtensions(Object.create(null, {
				add    : { value : onSaveAdd },
				clear  : { value : onSaveClear },
				delete : { value : onSaveDelete },
				size   : { get : onSaveSize }
			}))
		},

		/*
			Legacy API.
		*/
		get : {
			value() {
				throw new Error('[REMOVED] Save.get() has been removed.');
			}
		},
		clear : {
			value() {
				console.warn('[DEPRECATED] Save.clear() is deprecated.');
				return browserClear();
			}
		},
		ok : {
			value() {
				console.warn('[DEPRECATED] Save.ok() is deprecated.');
				return browserIsEnabled();
			}
		},

		// Autosave Functions.
		autosave : {
			value : Object.preventExtensions(Object.create(null, {
				ok : {
					value() {
						console.warn('[DEPRECATED] Save.autosave.ok() is deprecated.');
						return autoIsEnabled();
					}
				},
				has : {
					value() {
						console.warn('[DEPRECATED] Save.autosave.has() is deprecated.');
						return autoHas(0);
					}
				},
				get : {
					value() {
						console.warn('[DEPRECATED] Save.autosave.get() is deprecated.');
						return autoGet(0);
					}
				},
				load : {
					value() {
						console.warn('[DEPRECATED] Save.autosave.load() is deprecated.');
						return autoLoad(0);
					}
				},
				save : {
					value(...args) {
						console.warn('[DEPRECATED] Save.autosave.save() is deprecated.');
						return autoSave(...args);
					}
				},
				delete : {
					value() {
						console.warn('[DEPRECATED] Save.autosave.delete() is deprecated.');
						return autoDelete(0);
					}
				}
			}))
		},

		// Slots Functions.
		slots : {
			value : Object.preventExtensions(Object.create(null, {
				ok : {
					value() {
						console.warn('[DEPRECATED] Save.slots.ok() is deprecated.');
						return slotIsEnabled();
					}
				},
				length : {
					get() {
						console.warn('[DEPRECATED] Save.slots.length is deprecated.');
						return Config.saves.maxSlotSaves;
					}
				},
				isEmpty : {
					value() {
						console.warn('[DEPRECATED] Save.slots.isEmpty() is deprecated.');
						return slotSize() === 0;
					}
				},
				count : {
					value() {
						console.warn('[DEPRECATED] Save.slots.count() is deprecated.');
						return slotSize();
					}
				},
				has : {
					value(...args) {
						console.warn('[DEPRECATED] Save.slots.has() is deprecated.');
						return slotHas(...args);
					}
				},
				get : {
					value(...args) {
						console.warn('[DEPRECATED] Save.slots.get() is deprecated.');
						return slotGet(...args);
					}
				},
				load : {
					value(...args) {
						console.warn('[DEPRECATED] Save.slots.load() is deprecated.');
						return slotLoad(...args);
					}
				},
				save : {
					value(...args) {
						console.warn('[DEPRECATED] Save.slots.save() is deprecated.');
						return slotSave(...args);
					}
				},
				delete : {
					value(...args) {
						console.warn('[DEPRECATED] Save.slots.delete() is deprecated.');
						return slotDelete(...args);
					}
				}
			}))
		},

		// Disk Import/Export Functions.
		export : {
			value(...args) {
				console.warn('[DEPRECATED] Save.export() is deprecated.');
				return diskSave(...args);
			}
		},
		import : {
			value(...args) {
				console.warn('[DEPRECATED] Save.import() is deprecated.');
				return diskLoad(...args);
			}
		},

		// Serialization Saves Functions.
		serialize : {
			value(...args) {
				console.warn('[DEPRECATED] Save.serialize() is deprecated.');
				return base64Save(...args);
			}
		},
		deserialize : {
			value(...args) {
				console.warn('[DEPRECATED] Save.deserialize() is deprecated.');
				return base64Load(...args);
			}
		}
	}));
})();

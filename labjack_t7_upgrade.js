/**
 * Logic to upgrade the firmware on a LabJack T7.
 *
 * @author Chris Johnson (chrisjohn404)
 * @author Sam Pottinger (samnsparky)
**/

var fs = require('fs');

var async = require('async');
var labjack_nodejs = require('labjack-nodejs');
var lazy = require('lazy');
var q = require('q');
var driver_const = labjack_nodejs.driver_const;

var DEBUG_CHECK_ERASE = true;
var DEBUG_CHECK_WRITE = true;
var ALLOWED_IMAGE_INFO_DEVICE_TYPES = [
	driver_const.T7_TARGET_OLD,
	driver_const.T7_TARGET
];
var EXPECTED_ZEROED_MEM_VAL = 0;
var EXPECTED_REBOOT_WAIT = 5000;


function range(start, stop, step){
    if (typeof stop=='undefined'){
        // one param defined
        stop = start;
        start = 0;
    };
    if (typeof step=='undefined'){
        step = 1;
    };
    if ((step>0 && start>=stop) || (step<0 && start<=stop)){
        return [];
    };
    var result = [];
    for (var i=start; step>0 ? i<stop : i>stop; i+=step){
        result.push(i);
    };
    return result;
};


function DeviceFirmwareBundle()
{
	var firmwareImageInformation = null;
	var firmwareImage = null;
	var deviceImage = null;
	var device = null;
	var version = null;
	var serial = null;

	this.getFirmwareImage = function()
	{
		return firmwareImage;
	};

	this.setFirmwareImage = function(newFirmwareImage)
	{
		firmwareImage = newFirmwareImage;
	};

	this.getFirmwareImageInformation = function()
	{
		return firmwareImageInformation;
	};

	this.setFirmwareImageInformation = function(newFirmwareImageInformation)
	{
		firmwareImageInformation = newFirmwareImageInformation;
	};

	this.getDeviceImage = function()
	{
		return deviceImage;
	};

	this.setDeviceImage = function(newDeviceImage)
	{
		deviceImage = newDeviceImage;
	};

	this.setDevice = function(newDevice)
	{
		device = newDevice;
	};

	this.getDevice = function()
	{
		return device;
	};

	this.getFirmwareVersion = function()
	{
		return version;
	};

	this.setFirmwareVersion = function(newVersion)
	{
		version = newVersion;
	};

	this.setSerialNumber = function(newSerial)
	{
		serial = newSerial;
	};

	this.getSerialNumber = function()
	{
		return serial;
	};
}


/**
 * Reads the contents of the specified firmware file into memory.
 *
 * Reads the raw contents of the specified firmware file asynchronously. Note
 * that the entire file is read into memory.
 *
 * @param {String} fileSrc The full path to the file to read.
 * @return {q.promise} New DeviceFirmwareBundle without a device loaded but
 *		initalized with the contents of the specified firmware file.
**/
exports.readFirmwareFile = function(fileSrc)
{
	var deferred = q.defer();

	var bundle = new DeviceFirmwareBundle();

	fs.readFile(fileSrc, function (err, data) {
		var headerBuffer = new Buffer(data);
		var imageInformation = {
			headerCode: headerBuffer.readUInt32BE(driver_const.HEADER_CODE),
			intendedDevice: headerBuffer.readUInt32BE(driver_const.HEADER_TARGET),
			containedVersion: headerBuffer.readFloatBE(driver_const.HEADER_VERSION).toFixed(4),
			requiredUpgraderVersion: headerBuffer.readFloatBE(driver_const.HEADER_REQ_LJSU).toFixed(4),
			imageNumber: headerBuffer.readUInt16BE(driver_const.HEADER_IMAGE_NUM),
			numImgInFile: headerBuffer.readUInt16BE(driver_const.HEADER_NUM_IMAGES),
			startNextImg: headerBuffer.readUInt32BE(driver_const.HEADER_NEXT_IMG),
			lenOfImg: headerBuffer.readUInt32BE(driver_const.HEADER_IMG_LEN),
			imgOffset: headerBuffer.readUInt32BE(driver_const.HEADER_IMG_OFFSET),
			numBytesInSHA: headerBuffer.readUInt32BE(driver_const.HEADER_SHA_BYTE_COUNT),
			options: headerBuffer.readUInt32BE(72),
			encryptedSHA: headerBuffer.readUInt32BE(driver_const.HEADER_ENC_SHA1),
			unencryptedSHA: headerBuffer.readUInt32BE(driver_const.HEADER_SHA1),
			headerChecksum: headerBuffer.readUInt32BE(driver_const.HEADER_CHECKSUM)
		};
		bundle.setFirmwareImageInformation(imageInformation);

		var versionStr = fileSrc.replace('T7_firmware_', '');
		versionStr = versionStr.substr(0,versionStr.indexOf('_'));
		bundle.setFirmwareVersion(Number(versionStr)/10000);
		
		deferred.resolve(bundle);
	});

	return deferred.promise;
};


/**
 * Ensure that the given firmware image is compatible with the given device.
 *
 * @param {DeviceFirmwareBundle} bundle The firmware and corresponding device to
 *		check compatability for.
 * @return {q.promise} Promise that resolves to the provided device bundle.
 * @throws {Error} Thrown if the firmware image is not compatible.
**/
exports.checkCompatibility = function(bundle)
{
	var deferred = q.defer();

	var expectedHeaderCode = driver_const.T7_HEAD_FIRST_FOUR_BYTES;
	var imageInformation = bundle.getFirmwareImageInformation();
	var firmwareVersion = bundle.getFirmwareVersion();

	var headerCodeCorrect = imageInformation.headerCode == expectedHeaderCode;
	var intendedDeviceCorrect = ALLOWED_IMAGE_INFO_DEVICE_TYPES.indexOf(
		imageInformation.intendedDevice) != -1;
	var versionCorrect = imageInformation.containedVersion == firmwareVersion;

	if (headerCodeCorrect && intendedDeviceCorrect && versionCorrect) {
		deferred.resolve(bundle);
	} else {
		if (!headerCodeCorrect)
			deferred.reject(new Error('Invalid header code.'));
		else if(!intendedDeviceCorrect)
			deferred.reject(new Error('Incorrect device type.'));
		else
			deferred.reject(new Error('Incorrect version.'));
	}
	
	return deferred.promise;
};


/**
 * Erases n number of flash pages on the device within the provided bundle.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device to perform
 *		the erase operation on.
 * @param {Number} startAddress The address to start erasing flash pages on.
 * @param {Number} numPages The number of pages to erase;
 * @param {Number} key Permissions key for that range.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *		erase is complete.
**/
exports.eraseFlash = function(bundle, startAddress, numPages, key)
{
	var deferred = q.defer();

	var device = bundle.getDevice();
	var pages = range(numPages);
	async.eachSeries(
		pages,
		function (page, callback) {
			device.writeMany(
				[driver_const.T7_MA_EXF_KEY, driver_const.T7_MA_EXF_ERASE],
				[key, startAddress + page * driver_const.T7_FLASH_PAGE_SIZE],
				function (err) { callback(err); },
				function () { callback(null); }
			);
		},
		function (err) {
			if (err)
				deferred.reject( new Error(err) );
			else
				deferred.resolve(bundle);
		}
	);

	return deferred.promise;
};


/**
 * Erases the existing image in the device within the provided bundle.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device to perform
 *		the erase operation on.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *		erase is complete.
**/
exports.eraseImage = function(bundle)
{
	var deferred = q.defer();

	exports.eraseFlash(
		bundle,
		driver_const.T7_EFAdd_ExtFirmwareImage,
		driver_const.T7_IMG_FLASH_PAGE_ERASE,
		driver_const.T7_EFkey_ExtFirmwareImage
	).then(
		function() { deferred.resolve(bundle); },
		function(err) { deferred.reject(err); }
	);

	return deferred.promise;
};


/**
 * Erases the existing header in the device within the provided bundle.
 *
 * Erases the existing image information in the device within the provided
 * bundle.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device to perform
 *		the erase operation on.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *		erase is complete.
**/
exports.eraseImageInformation = function(bundle)
{
	var deferred = q.defer();

	exports.eraseFlash(
		bundle,
		driver_const.T7_EFAdd_ExtFirmwareImage,
		driver_const.T7_HDR_FLASH_PAGE_ERASE,
		driver_const.T7_EFkey_ExtFirmwareImgInfo
	).then(
		function() { deferred.resolve(bundle); },
		function(err) { deferred.reject(err); }
	);

	return deferred.promise;
};


var readWriteOperation = function (bundle, startAddress, lengthInts, sizeInts,
	ptrAddress, readFlashAddress, deviceFunction, key)
{
	var deferred = q.defer();
	var device = bundle.getDevice();
	
	// Creates a closure over a rw excutiong with an address and size
	var createExecution = function(address, innerSize)
	{
		return function (lastResults) {
			var innerDeferred = q.defer();

			var addresses = [];
			var values = [];
			var directions = [];

			if (key !== undefined) {
				addresses.push(driver_const.T7_MA_EXF_KEY);
				values.push(key);
			}

			addresses.push(ptrAddress);
			values.push(address);
			directions.push(driver_const.LJM_WRITE);

			for(var i=0; i<innerSize; i++)
			{
				addresses.push(readFlashAddress);
				values.push(null);
				directions.push(driver_const.LJM_READ);
			}

			deviceFunction(
				addresses,
				directions,
				values,
				innerDeferred.reject,
				function (newResults) { 
					lastResults.push.apply(lastResults, newResults);
					innerDeferred.resolve(lastResults);
				}
			);

			return innerDeferred.promise;
		};
	};

	var executeOperations = [];
	var size = sizeInts * 4;
	var length = lengthInts * 4;
	var numIterations = Math.floor(length / size);
	var remainder = length % size;
	var shouldAugment = remainder > 0;
	var currentAddress = startAddress;

	for (var i = 0; i<numIterations; i++)
	{
		executeOperations.push(createExecution(currentAddress, size));
		currentAddress += size;
	}

	if (shouldAugment) {
		executeOperations.push(createExecution(currentAddress, remainder));
	}
	
	async.reduce(
		executeOperations,
		[],
		function (lastMemoryResult, currentExecution, callback) {
			currentExecution(lastMemoryResult).then(function(newMemory){
				callback(null, newMemory);
			});
		},
		function (err, allMemoryRead) {
			if (err) {
				deferred.reject( err );
			} else {
				deferred.resolve(allMemoryRead);
			}
		}
	);

	return deferred.promise;
}


/**
 * Reads desired flash memory region from the device.
 *
 * @param {DeviceFirwareBundle} bundle The bundle with the device to read from.
 * @param {Number} startAddress The address to start reading at.
 * @param {Number} length Number of integers to read.
 * @param {Number} size The number of reads to combine in a single read call.
**/
exports.readFlash = function(bundle, startAddress, length, size)
{
	var readPtrAddress = driver_const.T7_MA_EXF_pREAD;
	var readFlashAddress = driver_const.T7_MA_EXF_READ;
	var device = bundle.getDevice();
	return readWriteOperation(
		bundle,
		startAddress,
		length,
		size,
		readPtrAddress,
		readFlashAddress,
		function (addresses, directions, values, onError, onSuccess) {
			device.rwMany(
				addresses,
				directions,
				values,
				onError,
				onSuccess
			);
		}
	);
}

/**
 * Reads image from flash memory.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device to read from.
 * @return {q.promise} Promise that resolves to the image as read from memory
 *		contents.
**/
exports.readImage = function(bundle)
{
	var deferred = q.defer();

	var numberOfIntegers = driver_const.T7_IMG_FLASH_PAGE_ERASE *
		driver_const.T7_FLASH_PAGE_SIZE / 4;

	exports.readFlash(
		bundle,
		driver_const.T7_EFAdd_ExtFirmwareImage,
		numberOfIntegers,
		driver_const.T7_FLASH_BLOCK_WRITE_SIZE
	).then(
		function (memoryContents) { deferred.resolve(memoryContents); },
		function (err) { deferred.reject(err); }
	);

	return deferred.promise;
};

/**
 * Reads image information from flash memory.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device to read from.
 * @return {q.promise} Promise that resolves to the image information as read
 *		from memory contents.
**/
exports.readImageInformation = function(bundle)
{
	var deferred = q.defer();

	var numberOfIntegers = driver_const.T7_HDR_FLASH_PAGE_ERASE *
		driver_const.T7_FLASH_PAGE_SIZE / 4;

	exports.readFlash(
		bundle,
		driver_const.T7_EFAdd_ExtFirmwareImgInfo,
		numberOfIntegers,
		driver_const.T7_FLASH_BLOCK_WRITE_SIZE
	).then(
		function (memoryContents) { deferred.resolve(memoryContents); },
		function (err) { deferred.reject(err); }
	);

	return deferred.promise;
};


/**
 * Check that all image information and image pages have been erased.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device to check.
 * @return {q.promise} Promise that resovles to the provided bundle.
 * @throws {Error} Error thrown if the image and image information pages on the
 *		specified device are not zeroed.
**/
exports.checkErase = function(bundle)
{
	var deferred = q.defer();

	var isAllZeroed = function (memory)
	{
		for(var i=0; i<memoryLength; i++)
		{
			if (memory[i] != EXPECTED_ZEROED_MEM_VAL)
				return false;
		}

		return true;
	}

	var checkMemory = function (targetFunction)
	{
		return function (bundle) {
			var innerDeferred = q.defer();

			targetFunction(bundle).then(function (memory)
			{
				if (!isAllZeroed(memory))
					deferred.reject(new Error('Memory not zeroed.'));
				else
					innerDeferred.resolve(bundle);
			});

			return innerDeferred.promise;
		};
	}

	readImageInformation()
	.then(checkMemory(readImage))
	.then(checkMemory(readImageInformation))
	.then(function () {
		deferred.resolve(bundle);
	});

	return deferred.promise;
};


exports.writeFlash = function(bundle, startAddress, length, size, key)
{
	var readPtrAddress = driver_const.T7_MA_EXF_pWRITE;
	var readFlashAddress = driver_const.T7_MA_EXF_WRITE;
	var device = bundle.getDevice();
	return readWriteOperation(
		bundle,
		startAddress,
		length,
		size,
		readPtrAddress,
		readFlashAddress,
		function (addresses, directions, values, onError, onSuccess) {
			device.writeMany(
				addresses,
				values,
				onError,
				onSuccess
			);
		},
		key
	);
}


/**
 * Write the image in the provided bundle to the device in that bundle.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle to perform the write in.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *		write is complete.
**/
exports.writeImage = function(bundle)
{
	var deferred = q.defer();

	var numberOfIntegers = driver_const.T7_IMG_FLASH_PAGE_ERASE *
		driver_const.T7_FLASH_PAGE_SIZE / 4;

	exports.writeFlash(
		bundle,
		driver_const.T7_EFAdd_ExtFirmwareImage,
		numberOfIntegers,
		driver_const.T7_FLASH_BLOCK_WRITE_SIZE,
		driver_const.T7_EFkey_ExtFirmwareImage
	).then(
		function (memoryContents) { deferred.resolve(memoryContents); },
		function (err) { deferred.reject(err); }
	);

	return deferred.promise;
};


/**
 * Write the header in the provided bundle to the device in that bundle.
 *
 * Write the image information in the provided bundle to the device within that
 * bundle.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle to perform the write in.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *		write is complete.
**/
exports.writeImageInformation = function(bundle)
{
	var deferred = q.defer();

	var numberOfIntegers = driver_const.T7_HDR_FLASH_PAGE_ERASE *
		driver_const.T7_FLASH_PAGE_SIZE / 4;

	exports.writeFlash(
		bundle,
		driver_const.T7_EFAdd_ExtFirmwareImgInfo,
		numberOfIntegers,
		driver_const.T7_FLASH_BLOCK_WRITE_SIZE,
		driver_const.T7_EFkey_ExtFirmwareImgInfo
	).then(
		function (memoryContents) { deferred.resolve(memoryContents); },
		function (err) { deferred.reject(err); }
	);

	return deferred.promise;
};


// TODO: Check image write information


/**
 * Check that the proper image / image information was written.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle to perform the check in.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *		check.
 * @throws {Error} Error thrown if the check fails.
**/
exports.checkImageWrite = function(bundle)
{
	var deferred = q.defer();

	exports.readImage(bundle).then(function (readImage) {
		var readImageLength = readImage.length;
		var bundleImage = bundle.getDeviceImage();
		for(var i=0; i<readImageLength; i++)
		{
			//console.log(bundleImage[i]);
			//console.log(readImage[i]);
			if (bundleImage[i] != readImage[i])
				deferred.reject(new Error('Unexpected image data at ' + i));
		}

		deferred.resolve(bundle);
	}, function (err) { deferred.reject(err); });

	return deferred.promise;
};


/**
 * Soft reboot the device, instructing it to upgrade in the process.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle to perform the upgrade in.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *		upgrade and reboot has started.
**/
exports.restartAndUpgrade = function(bundle)
{
	var deferred = q.defer();
	var device = bundle.getDevice();
	device.write(
		driver_const.T7_MA_REQ_FWUPG,
		driver_const.T7_REQUEST_FW_UPGRADE,
		function (err) { deferred.reject(err); },
		function () { deferred.resolve(bundle); }
	);
	return deferred.promise;
};


/**
 * Wait for a device to re-enumerate.
 *
 * Wait for a specific device to re-enumerate. Will look for a device that has
 * the same attributes as the device in the provided bundle and update the
 * provided bundle with that new device after openining.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device information
 *		to match.
 * @return {q.promise} Promise that resolves to the updated bundle.
**/
exports.waitForEnumeration = function(bundle)
{
	var deferred = q.defer();
	var ljmDriver = new labjack_nodejs.ljmDriver();
	var targetSerial = bundle.getSerialNumber();

	var getAllConnectedSerials = function () {
		var deferred = q.defer();

		ljmDriver.listAll("LJM_dtT7", "LJM_ctUSB",
			function (err) { deferred.reject(err); },
			function (devicesInfo) {
				var serials = devicesInfo.map(function (e) {
					return e.serialNumber; 
				});
				deferred.resolve(serials);
			}
		)

		return deferred.promise;
	};

	var checkForDevice = function () {
		getAllConnectedSerials().then(function (serialNumbers) {
			if (serialNumbers.indexOf(targetSerial) != -1) {
				var newDevice = new labjack_nodejs.labjack();
				newDevice.open("LJM_dtT7", "LJM_ctUSB", targetSerial);
				bundle.setDevice(newDevice);
				deferred.resolve(bundle);
			} else {
				setTimeout(checkForDevice, EXPECTED_REBOOT_WAIT);
			}
		});
	}

	setTimeout(checkForDevice, EXPECTED_REBOOT_WAIT);

	return deferred.promise;
};


/**
 * Checks that firmware image / image info matches the firmware on a device.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device to check and
 *		the firmware image / image info to check for.
 * @return {q.promise} Promise that resolves to the provided bundle.
 * @throws {Error} Error thrown if the firmware does not match.
**/
exports.checkNewFirmware = function(bundle)
{
	var deferred = q.defer();

	bundle.getDevice().read('FIRMWARE_VERSION',
		function (err) { deferred.reject(err); },
		function (firmwareVersion) {
			if(bundle.getFirmwareVersion() != firmwareVersion) {
				var errorMsg = 'New firmware version does not reflect upgrade.';
				deferred.reject(new Error(errorMsg));
			} else {
				deferred.resolve(bundle);
			}
		}
	);

	return deferred.promise;
};


exports.updateFirmware = function(device, firmwareFileLocation)
{
	var injectDevice = function (bundle) {
		var deferred = q.defer();
		bundle.setDevice(device);
		deferred.resolve(bundle);
		return deferred.promise;
	};

	var reportError = function (error) {
		console.log(error);
	}

	readFirmwareFile(firmwareFileLocation, reportError)
	.then(injectDevice, reportError)
	.then(checkCompatibility, reportError)
	.then(eraseImage, reportError)
	.then(eraseImageInformation, reportError)
	.then(checkErase, reportError)
	.then(writeImage, reportError)
	.then(writeImageInformation, reportError)
	.then(checkImageWrite, reportError)
	.then(restartAndUpgrade, reportError)
	.then(waitForEnumeration, reportError)
	.then(checkNewFirmware, reportError)
	.fail(reportError);
};

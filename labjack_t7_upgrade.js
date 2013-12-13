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
var EXPECTED_ZEROED_MEM_VAL = 4294967295; // 0xFFFFFFFF
var EXPECTED_REBOOT_WAIT = 5000;


/**
 * Create a range enumeration like in Python.
 *
 * @param {int} start The first number in the sequence (inclusive).
 * @param {int} stop The last number in the sequence (non-inclusive).
 * @param {int} step The integer distance between members of the returned
 *      sequence.
 * @return {Array} Array with the numerical sequence.
 * @author Tadeck - http://stackoverflow.com/questions/8273047
**/
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


/**
 * Structure containing device and firmware information.
 *
 * Structure containing device and firmware information that is passed along the
 * pipeline of steps used to upgrade a device.
**/
function DeviceFirmwareBundle()
{
    var firmwareImageInformation = null;
    var firmwareImage = null;
    var deviceImage = null;
    var device = null;
    var version = null;
    var serial = null;

    /**
     * Get the raw contents of the firmware image.
     *
     * Get the contents of the firmware that the device is being upgraded to.
     * This is the raw file contents (binary) as read from the firmware bin
     * file.
     *
     * @return {Buffer} A node standard library Buffer with the raw firmware
     *      file contents.
    **/
    this.getFirmwareImage = function()
    {
        return firmwareImage;
    };

    /** 
     * Specify the raw contents of the firmware image.
     *
     * Provide the firmware that the device should be upgraded to. This is the
     * raw contents (binary) that will be written as the firmware image to the
     * device.
     *
     * @param {Buffer} newFirmwareImage A node standard library Buffer with the
     *      raw firmware (file) contents.
    **/
    this.setFirmwareImage = function(newFirmwareImage)
    {
        firmwareImage = newFirmwareImage;
    };

    /**
     * Get the image information header.
     *
     * Get the image information header for the firmware image that is being
     * written to the device.
     *
     * @return {Object} Object with information about the image being written
     *      to the device.
    **/
    this.getFirmwareImageInformation = function()
    {
        return firmwareImageInformation;
    };

    /**
     * Provide information about the image that is being written.
     *
     * Provide information parsed from the image header about that image.
     * Should include a rawImageInfo attribute that has the Node standard lib
     * Buffer with the raw data read from the bin file.
     *
     * @param {Object} newFirmwareImageInformation Object with parsed firmware
     *      image information.
    **/
    this.setFirmwareImageInformation = function(newFirmwareImageInformation)
    {
        firmwareImageInformation = newFirmwareImageInformation;
    };

    /**
     * Set the labjack-nodejs device object to operate on.
     *
     * Provide the labjack-nodejs device object that corresponds / encapsulates
     * the device to upgrade.
     *
     * @param {labjack-nodejs.device} newDevice The device to upgrade.
    **/
    this.setDevice = function(newDevice)
    {
        device = newDevice;
    };

    /**
     * Get the device that should be upgraded.
     *
     * Get the labjack-nodejs device that encapsulates the LabJack that should
     * be upgraded.
     *
    **/
    this.getDevice = function()
    {
        return device;
    };

    /**
     * Get the version of the firmware that is being installed on the device.
     *
     * @return {float} The version of the firmware that is being written to the
     *      device as part of this upgrade.
    **/
    this.getFirmwareVersion = function()
    {
        return version;
    };

    /**
     * Set the version of the firmware that is being installed on the device.
     *
     * @param {float} The version of the firmware that is being written to the
     *      device as part of this upgrade.
    **/
    this.setFirmwareVersion = function(newVersion)
    {
        //console.log(newVersion);
        version = newVersion;
    };

    /**
     * Set the serial number of the device that is being upgraded.
     *
     * Record the serial number of the device that is being upgraded. Will be
     * used in device re-enumeration.
     *
     * @param {float} newSerial The serial number of the device taht is being
     *      upgraded.
    **/
    this.setSerialNumber = function(newSerial)
    {
        serial = newSerial;
    };

    /**
     * Get the serial number of the device that is being upgraded.
     *
     * Get the recorded serial number of the device that is being upgraded. This
     * serial number should be checked against during device re-enumeration.
    **/
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
 *      initalized with the contents of the specified firmware file.
**/
exports.readFirmwareFile = function(fileSrc)
{
    var deferred = q.defer();

    var bundle = new DeviceFirmwareBundle();

    fs.readFile(fileSrc, function (err, data) {
        var imageFile = new Buffer(data);
        var imageInformation = {
            rawImageInfo: imageFile.slice(0, 128),
            headerCode: imageFile.readUInt32BE(driver_const.HEADER_CODE),
            intendedDevice: imageFile.readUInt32BE(driver_const.HEADER_TARGET),
            containedVersion: imageFile.readFloatBE(
                driver_const.HEADER_VERSION).toFixed(4),
            requiredUpgraderVersion: imageFile.readFloatBE(
                driver_const.HEADER_REQ_LJSU).toFixed(4),
            imageNumber: imageFile.readUInt16BE(driver_const.HEADER_IMAGE_NUM),
            numImgInFile: imageFile.readUInt16BE(
                driver_const.HEADER_NUM_IMAGES),
            startNextImg: imageFile.readUInt32BE(driver_const.HEADER_NEXT_IMG),
            lenOfImg: imageFile.readUInt32BE(driver_const.HEADER_IMG_LEN),
            imgOffset: imageFile.readUInt32BE(driver_const.HEADER_IMG_OFFSET),
            numBytesInSHA: imageFile.readUInt32BE(
                driver_const.HEADER_SHA_BYTE_COUNT),
            options: imageFile.readUInt32BE(72),
            encryptedSHA: imageFile.readUInt32BE(driver_const.HEADER_ENC_SHA1),
            unencryptedSHA: imageFile.readUInt32BE(driver_const.HEADER_SHA1),
            headerChecksum: imageFile.readUInt32BE(driver_const.HEADER_CHECKSUM)
        };
        bundle.setFirmwareImageInformation(imageInformation);
        bundle.setFirmwareImage(imageFile.slice(128, imageFile.length));

        var versionStr = fileSrc.split('_');
        versionStr = versionStr[1];
        bundle.setFirmwareVersion(Number(versionStr)/10000);
        
        deferred.resolve(bundle);
    });

    return deferred.promise;
};


/**
 * Ensure that the given firmware image is compatible with the given device.
 *
 * @param {DeviceFirmwareBundle} bundle The firmware and corresponding device to
 *      check compatability for.
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
 *      the erase operation on.
 * @param {Number} startAddress The address to start erasing flash pages on.
 * @param {Number} numPages The number of pages to erase;
 * @param {Number} key Permissions key for that range.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *      erase is complete.
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
                function (err) { console.log(err); callback(err); },
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
 *      the erase operation on.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *      erase is complete.
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
 *      the erase operation on.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *      erase is complete.
**/
exports.eraseImageInformation = function(bundle)
{
    var deferred = q.defer();

    exports.eraseFlash(
        bundle,
        driver_const.T7_EFAdd_ExtFirmwareImgInfo,
        driver_const.T7_HDR_FLASH_PAGE_ERASE,
        driver_const.T7_EFkey_ExtFirmwareImgInfo
    ).then(
        function() { deferred.resolve(bundle); },
        deferred.reject
    );

    return deferred.promise;
};


var createFlashOperation = function (bundle, startAddress, lengthInts, sizeInts,
    ptrAddress, flashAddress, isReadOp, key, data)
{
    var deferred = q.defer();
    var device = bundle.getDevice();
    
    // Creates a closure over a rw excutiong with an address and size
    var createExecution = function(address, innerSize, writeValues)
    {
        return function (lastResults) {
            var innerDeferred = q.defer();

            var addresses = [];
            var values = [];
            var directions = [];
            var numFrames;
            var numValues;

            // Flash memory pointer
            directions.push(driver_const.LJM_WRITE);

            // Key
            if (key === undefined) {
                numFrames = 2;
                numValues = [1];
            } else {
                // Write for key
                directions.push(driver_const.LJM_WRITE);
                addresses.push(driver_const.T7_MA_EXF_KEY);
                values.push(key);
                numFrames = 3;
                numValues = [1, 1];
            }

            if (isReadOp)
                directions.push(driver_const.LJM_READ);
            else
                directions.push(driver_const.LJM_WRITE);

            addresses.push(ptrAddress);
            values.push(address);
            addresses.push(flashAddress);

            if (isReadOp) {
                for (var i=0; i<innerSize; i++) {
                    values.push(null);
                }
            } else {
                values.push.apply(values, writeValues);
            }

            numValues.push(innerSize);

            device.rwMany(
                addresses,
                directions,
                numValues,
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

    var getdata = function (imageBuffer, numIntegers, offset) {
        var retArray = [];
        for (var i=0; i<numIntegers; i++) {
            retArray.push(imageBuffer.readUInt32BE(i*4 + offset));
        }
        return retArray;
    }

    var executeOperations = [];
    var size = sizeInts;
    var length = lengthInts;
    var numIterations = Math.floor(length / size);
    var remainder = length % size;
    var shouldAugment = remainder > 0;
    var currentAddress = startAddress;
    var offset = 0;
    var execution;

    for (var i = 0; i<numIterations; i++)
    {
        if (isReadOp) {
            execution = createExecution(
                currentAddress,
                size
            );
        } else {
            execution = createExecution(
                currentAddress,
                size,
                getdata(
                    data,
                    8, // 8 integer max for each rw op.
                    offset
                )
            );
        }
        executeOperations.push(execution);
        currentAddress += size * 4; // 4 bytes per integer written
        offset += 32; // 4 bytes per integer * 8 integers written
    }

    if (shouldAugment && remainder > 0) {
        if (isReadOp) {
            execution = createExecution(
                currentAddress,
                remainder
            );
        } else {
            execution = createExecution(
                currentAddress,
                remainder,
                getdata(
                    data,
                    remainder,
                    offset
                )
            );
        }
        executeOperations.push(execution);
    }

    async.reduce(
        executeOperations,
        [],
        function (lastMemoryResult, currentExecution, callback) {
            currentExecution(lastMemoryResult).then(
                function (newMemory){
                    callback(null, newMemory);
                },
                function (err) {
                    callback(err, null);
                }
            );
        },
        function (err, allMemoryRead) {
            if (err) {
                deferred.reject( err );
            } else {
                deferred.resolve(bundle);
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
    return createFlashOperation(
        bundle,
        startAddress,
        length,
        size,
        readPtrAddress,
        readFlashAddress,
        true
    );
}

/**
 * Reads image from flash memory.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device to read from.
 * @return {q.promise} Promise that resolves to the image as read from memory
 *      contents.
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
        function (memoryContents) { deferred.resolve(bundle); },
        function (err) { console.log(err); deferred.reject(err); }
    );

    return deferred.promise;
};

/**
 * Reads image information from flash memory.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device to read from.
 * @return {q.promise} Promise that resolves to the image information as read
 *      from memory contents.
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
        function (memoryContents) { console.log('finished'); deferred.resolve(bundle); },
        function (err) { console.log(err); deferred.reject(err); }
    );

    return deferred.promise;
};


/**
 * Check that all image information and image pages have been erased.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle with the device to check.
 * @return {q.promise} Promise that resovles to the provided bundle.
 * @throws {Error} Error thrown if the image and image information pages on the
 *      specified device are not zeroed.
**/
exports.checkErase = function(bundle)
{
    var deferred = q.defer();

    var isAllZeroed = function (memory)
    {
        var memoryLength = memory.length;
        for(var i=0; i<memoryLength; i++)
        {
            if (memory[i] != EXPECTED_ZEROED_MEM_VAL)
                return false;
        }

        return true;
    };

    var checkIfZeroedThenContinue = function (memory) {
        var innerDeferred = q.defer();
        if (isAllZeroed(memory)) {
            innerDeferred.resolve();
        } else {
            innerDeferred.reject(new Error('Not zeroed')); // TODO: Lame error.
        }
    };

    var checkMemory = function (targetFunction)
    {
        return function () {
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
    };

    exports.readImageInformation(bundle)
    .then(checkIfZeroedThenContinue, deferred.reject)
    .then(checkMemory(exports.readImage), deferred.reject)
    .then(function () {
        deferred.resolve(bundle);
    }, deferred.reject);

    return deferred.promise;
};


exports.writeFlash = function(bundle, startAddress, length, size, key, data)
{
    var writePtrAddress = driver_const.T7_MA_EXF_pWRITE;
    var writeFlashAddress = driver_const.T7_MA_EXF_WRITE;
    var device = bundle.getDevice();
    return createFlashOperation(
        bundle,
        startAddress,
        length,
        size,
        writePtrAddress,
        writeFlashAddress,
        false,
        key,
        data
    );
}


/**
 * Write the image in the provided bundle to the device in that bundle.
 *
 * @param {DeviceFirmwareBundle} bundle The bundle to perform the write in.
 * @return {q.promise} Promise that resolves to the provided bundle after the
 *      write is complete.
**/
exports.writeImage = function(bundle)
{
    var deferred = q.defer();

    // 4 bytes per integer
    var numberOfIntegers = bundle.getFirmwareImage().length / 4;

    exports.writeFlash(
        bundle,
        driver_const.T7_EFAdd_ExtFirmwareImage,
        numberOfIntegers,
        driver_const.T7_FLASH_BLOCK_WRITE_SIZE,
        driver_const.T7_EFkey_ExtFirmwareImage,
        bundle.getFirmwareImage()
    ).then(
        function (memoryContents) { deferred.resolve(bundle); },
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
 *      write is complete.
**/
exports.writeImageInformation = function(bundle)
{
    var deferred = q.defer();

    var rawImageInfo = bundle.getFirmwareImageInformation().rawImageInfo;

    // 4 bytes per integer
    var numberOfIntegers = rawImageInfo.length / 4;

    exports.writeFlash(
        bundle,
        driver_const.T7_EFAdd_ExtFirmwareImgInfo,
        numberOfIntegers,
        driver_const.T7_FLASH_BLOCK_WRITE_SIZE,
        driver_const.T7_EFkey_ExtFirmwareImgInfo,
        rawImageInfo
    ).then(
        function (memoryContents) { deferred.resolve(bundle); },
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
 *      check.
 * @throws {Error} Error thrown if the check fails.
**/
exports.checkImageWrite = function(bundle)
{
    var deferred = q.defer();

    exports.readImage(bundle).then(function (readImage) {
        var readImageLength = readImage.length;
        var bundleImage = bundle.getFirmwareImage();
        for(var i=0; i<readImageLength; i++)
        {
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
 *      upgrade and reboot has started.
**/
exports.restartAndUpgrade = function(bundle)
{
    var deferred = q.defer();
    var device = bundle.getDevice();
    device.write(
        driver_const.T7_MA_REQ_FWUPG,
        driver_const.T7_REQUEST_FW_UPGRADE,
        function (err) { deferred.reject(err); },
        function () { device.closeSync(); deferred.resolve(bundle); }
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
 *      to match.
 * @return {q.promise} Promise that resolves to the updated bundle.
**/
exports.waitForEnumeration = function(bundle)
{
    console.log('waitForEnumeration');
    var deferred = q.defer();
    var ljmDriver = new labjack_nodejs.driver();
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
                var newDevice = new labjack_nodejs.device();
                newDevice.openSync("LJM_dtT7", "LJM_ctUSB", targetSerial);
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
 *      the firmware image / image info to check for.
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


/**
 * Facade / entry point for the update firmware pipeline.
 *
 * @param {labjack-nodejs.device} device The device to update.
 * @param {String} firmwareFileLocation The location of the bin file to read the
 *      firmware from.
 * @return {q.promise} Promise that resolves after the build process completes.
**/
exports.updateFirmware = function(device, firmwareFileLocation)
{
    var deferred = q.defer();

    var injectDevice = function (bundle) {
        var innerDeferred = q.defer();
        bundle.setSerialNumber(device.readSync('SERIAL_NUMBER'));
        bundle.setDevice(device);
        innerDeferred.resolve(bundle);
        return innerDeferred.promise;
    };

    var reportError = function (error) {
        deferred.reject(error);
        throw error;
    };

    exports.readFirmwareFile(firmwareFileLocation, reportError)
    .then(injectDevice, reportError)
    .then(exports.checkCompatibility, reportError)
    .then(exports.eraseImage, reportError)
    .then(exports.eraseImageInformation, reportError)
    .then(exports.checkErase, reportError)
    .then(exports.writeImage, reportError)
    .then(exports.writeImageInformation, reportError)
    .then(exports.checkImageWrite, reportError)
    .then(exports.restartAndUpgrade, reportError)
    .then(exports.waitForEnumeration, reportError)
    .then(exports.checkNewFirmware, reportError)
    .fail(deferred.resolve, reportError);

    return deferred.promise;
};

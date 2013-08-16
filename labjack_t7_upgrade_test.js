/**
 * Unit tests for LabJack T7 upgrade logic.
 *
 * @author Chris Johnson (chrisjohn404)
 * @author Sam Pottinger (samnsparky)
**/

var q = require('q');
var rewire = require('rewire');

var driver_const = require('labjack-nodejs').driver_const;

var labjack_t7_upgrade = rewire('./labjack_t7_upgrade');

var TEST_DATA = 'abcdefghijklmnopqrstuvwxyz1234567890';
var FAKE_HEADER_LENGTH = 5;
var TEST_FIRMWARE_CODE = 1;
var NUM_PAGE_ERASE = 2;
var FAKE_DEVICE_TYPE = 2;
var FAKE_SERIAL_NUMBER = '1234';
var TEST_EXPECTED_REBOOT_WAIT = 1;


// Dependency inject file system read
// TODO: Check src
//labjack_t7_upgrade.__set__('driver_const.T7_IMG_HEADER_LENGTH', FAKE_HEADER_LENGTH);
labjack_t7_upgrade.__set__('driver_const.T7_HEAD_FIRST_FOUR_BYTES',
	TEST_FIRMWARE_CODE);
labjack_t7_upgrade.__set__('EXPECTED_REBOOT_WAIT',
	TEST_EXPECTED_REBOOT_WAIT);

var DeviceFirmwareBundle = labjack_t7_upgrade.__get__('DeviceFirmwareBundle');


function MockDevice()
{
	// Address or addresses last passed to this mock device.
	var lastAddress = [];

	// Value or values last passed to this mock device.
	var lastValue = [];

	// Last set of directinos passed to this mock device.
	var lastDirections = [];

	var lastFrames = [];
	var lastNumValues = [];

	// Value to return on the next read call to this mock device.
	var nextValue = null;

	var numReadsRead = 0;

	this.deviceType = null;

	this.write = function (address, value, onError, onSuccess) {
		lastAddress.push(address);
		lastValue.push(value);
		onSuccess();
	};

	this.writeMany = function (addressess, values, onError, onSuccess) {
		lastAddress.push(addressess);
		lastValue.push(values);
		onSuccess();
	};
	//NumFrames: Total number of operations to perform 
	//Addresses: array of addresses to be operated upon
	//Writes: Directions of the operations
	//numValues: How many times to iterate each operation
	//values: what values to write for each write with dummy values inserted 
	//		for reads
	/*
	if numFrames = 2
	Addresses = [0,1000]//AIN0 & DAC0
	Writes = [READ, WRITE]
	numValues = [4, 2]
	values: [dummy, dummy, dummy, dummy, 2.5, 2.5]

	Total Request breaking down into read/write many...:
	1. Read: AIN0
	2. Read: AIN1
	3. Read: AIN2
	4. Read: AIN3
	5. Write: DAC0, 2.5
	6. Write: DAC1, 2.5
	*/
	this.rwMany = function (numFrames, addresses, directions, numValues,
		values, onError, onSuccess)
	{
		lastFrames.push(numFrames);
		lastAddress.push(addresses);
		lastDirections.push(directions);
		lastNumValues.push(numValues);
		lastValue.push(values);
		onSuccess(this.getNextValueToReturn());
	}
	
	/*this.rwMany = function (addresses, directions, values, onError, onSuccess)
	{
		lastAddress.push(addresses);
		lastDirections.push(directions);
		lastValue.push(values);
		onSuccess(this.getNextValueToReturn());
	};*/

	this.read = function (address, onError, onSuccess) {
		lastAddress.push(address);
		onSuccess(this.getNextValueToReturn());
	};

	this.readMany = function (addresses, onError, onSuccess) {
		lastAddress.push(address);
		onSuccess(this.getNextValueToReturn());
	};

	

	this.getNextValueToReturn = function()
	{
		var nextValueToReturn;

		if (nextValue instanceof Array) {
			nextValueToReturn = nextValue[numReadsRead];
			numReadsRead++;
		} else {
			nextValueToReturn = nextValue;
		}

		return nextValueToReturn;
	}

	this.getLastAddress = function () {
		return lastAddress;
	};

	this.getLastValue = function () {
		return lastValue;
	};

	this.getNextValue = function () {
		return nextValue;
	};

	this.setNextValue = function (newVal) {
		nextValue = newVal;
	};

	this.getLastDirections = function () {
		return lastDirections;
	};

	this.getLastNumValues = function () {
		return lastNumValues;
	};

	this.getLastFrames = function () {
		return lastFrames;
	};

	this.reset = function () {
		lastAddress = [];
		lastValue = [];
		directions = [];
		nextValue = null;
		numReadsRead = 0;
	}
}


module.exports = {

	setUp: function(callback)
	{
		this.mockDevice = new MockDevice();
		callback();
	},

	testReadFirmwareFile: function(test)
	{
		var testFirmwareFileSrc = 'T7_firmware_100000_200000.bin'
		var testFileBuffer = new Buffer(driver_const.T7_IMG_HEADER_LENGTH);
		testFileBuffer.writeUInt32BE(123, driver_const.HEADER_CODE);
		testFileBuffer.fill(0, 4);

		var fakeReadFile = function (src, callback) {
			callback(null, testFileBuffer.toString());
		};
		
		labjack_t7_upgrade.__set__('fs', {readFile: fakeReadFile});

		labjack_t7_upgrade.readFirmwareFile(testFirmwareFileSrc)
		.then(function (bundle) {
			test.equal(bundle.getFirmwareImageInformation().headerCode, 123);

			test.equal(bundle.getFirmwareVersion(), 10);
			test.done();
		}, function(err) { test.ok(false, err); test.done(); });
	},


	testCheckCompatibilitySuccess: function(test)
	{
		var code = TEST_FIRMWARE_CODE;
		var deviceType = driver_const.T7_TARGET_OLD;
		var version = 3;

		var fakeFirmwareInfo = {
			headerCode: code,
			intendedDevice: deviceType,
			containedVersion: version
		};

		var testDevice = new MockDevice();
		testDevice.deviceType = deviceType;

		var testBundle = new DeviceFirmwareBundle();
		testBundle.setFirmwareImageInformation(fakeFirmwareInfo);
		testBundle.setFirmwareVersion(version);
		testBundle.setDevice(testDevice);

		labjack_t7_upgrade.checkCompatibility(testBundle).then( function () {
			test.done();
		}, function (error) {
			test.ok(false, 'Failed compatability check. ' + error);
			test.done();
		});
	},


	testCheckCompatibilityFailFirmwareCode: function(test)
	{
		var code = TEST_FIRMWARE_CODE;
		var deviceType = FAKE_DEVICE_TYPE;
		var version = 3;

		var fakeFirmwareInfo = {
			headerCode: code + 1,
			intendedDevice: deviceType,
			containedVersion: version
		};

		var testDevice = new MockDevice();
		testDevice.deviceType = deviceType;

		var testBundle = new DeviceFirmwareBundle();
		testBundle.setFirmwareImageInformation(fakeFirmwareInfo);
		testBundle.setFirmwareVersion(version);
		testBundle.setDevice(testDevice);

		labjack_t7_upgrade.checkCompatibility(testBundle).fail( function () {
			test.done();
		});
	},


	testCheckCompatibilityFailDeviceType: function(test)
	{
		var code = TEST_FIRMWARE_CODE;
		var deviceType = FAKE_DEVICE_TYPE;
		var version = 3;

		var fakeFirmwareInfo = {
			headerCode: code,
			intendedDevice: deviceType+1,
			containedVersion: version
		};

		var testDevice = new MockDevice();
		testDevice.deviceType = deviceType;

		var testBundle = new DeviceFirmwareBundle();
		testBundle.setFirmwareImageInformation(fakeFirmwareInfo);
		testBundle.setFirmwareVersion(version);
		testBundle.setDevice(testDevice);

		labjack_t7_upgrade.checkCompatibility(testBundle).fail( function () {
			test.done();
		});
	},


	testCheckCompatibilityFailVersion: function(test)
	{
		var code = TEST_FIRMWARE_CODE;
		var deviceType = FAKE_DEVICE_TYPE;
		var version = 3;

		var fakeFirmwareInfo = {
			headerCode: code,
			intendedDevice: deviceType,
			containedVersion: version+1
		};

		var testDevice = new MockDevice();
		testDevice.deviceType = deviceType;

		var testBundle = new DeviceFirmwareBundle();
		testBundle.setFirmwareImageInformation(fakeFirmwareInfo);
		testBundle.setFirmwareVersion(version);
		testBundle.setDevice(testDevice);

		labjack_t7_upgrade.checkCompatibility(testBundle).fail( function () {
			test.done();
		});
	},


	testEraseFlash: function(test)
	{
		var address1 = driver_const.T7_MA_EXF_KEY;
		var address2 = driver_const.T7_MA_EXF_ERASE;
		var keyValue = driver_const.T7_EFkey_ExtFirmwareImgInfo;
		var paramAddress1 = driver_const.T7_EFAdd_ExtFirmwareImgInfo;
		var paramAddress2 = paramAddress1 + driver_const.T7_FLASH_PAGE_SIZE;
		var expectedValues = [
			[keyValue, paramAddress1],
			[keyValue, paramAddress2],
		];
		var expectedAddresses = [
			[address1, address2],
			[address1, address2]
		];

		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);

		labjack_t7_upgrade.eraseFlash(testBundle, paramAddress1, 2, keyValue)
		.then(function () {
			test.deepEqual(testDevice.getLastAddress(), expectedAddresses);
			test.deepEqual(testDevice.getLastValue(), expectedValues);
			test.done();
		});
	},


	testEraseImage: function(test)
	{
		var expectedNumWrites = driver_const.T7_IMG_FLASH_PAGE_ERASE;
		var expectedFirstAddr = driver_const.T7_EFAdd_ExtFirmwareImage;
		var pageSize = driver_const.T7_FLASH_PAGE_SIZE;
		var numBytesErasedBeforeLast = (expectedNumWrites - 1) * pageSize;
		var expectedLastAddr = expectedFirstAddr + numBytesErasedBeforeLast;

		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);

		labjack_t7_upgrade.eraseImage(testBundle).then(function(){
			var valuesWritten = testDevice.getLastValue();
			test.equal(valuesWritten.length, expectedNumWrites);
			test.equal(valuesWritten[0][0],
				driver_const.T7_EFkey_ExtFirmwareImage);
			test.equal(valuesWritten[0][1], expectedFirstAddr);
			test.equal(valuesWritten[valuesWritten.length-1][1],
				expectedLastAddr);
			test.done();
		}, function(err) { test.ok(false, err); test.done(); });
	},


	testEraseImageInformation: function(test)
	{
		var expectedNumWrites = driver_const.T7_HDR_FLASH_PAGE_ERASE;
		var expectedFirstAddr = driver_const.T7_EFAdd_ExtFirmwareImage;
		var pageSize = driver_const.T7_FLASH_PAGE_SIZE;
		var numBytesErasedBeforeLast = (expectedNumWrites - 1) * pageSize;
		var expectedLastAddr = expectedFirstAddr + numBytesErasedBeforeLast;

		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);

		labjack_t7_upgrade.eraseImageInformation(testBundle).then(function(){
			var valuesWritten = testDevice.getLastValue();
			test.equal(valuesWritten.length, expectedNumWrites);
			test.equal(valuesWritten[0][1], expectedFirstAddr);
			test.equal(valuesWritten[0][0],
				driver_const.T7_EFkey_ExtFirmwareImgInfo);
			test.equal(valuesWritten[valuesWritten.length-1][1],
				expectedLastAddr);
			test.done();
		}, function(err) { test.ok(false, err); test.done(); });
	},


	testReadFlash: function(test)
	{
		var writeSize = driver_const.T7_FLASH_BLOCK_WRITE_SIZE;
		var length = writeSize*1.5;
		var size = writeSize;
		var paramAddress1 = 0;
		var paramAddress2 = 8;
		var readPtrAddress = driver_const.T7_MA_EXF_pREAD;
		var readFlashAddress = driver_const.T7_MA_EXF_READ;

		var expectedMemory = [[1, 2], [3]];
		var expectedReturnMemory = [1, 2, 3];

		var expectedValues = [
			[paramAddress1, null, null, null, null, null, null, null, null],
			[paramAddress2, null, null, null, null],
		];

		var expectedAddresses = [
			[
				readPtrAddress,
				readFlashAddress
			],
			[
				readPtrAddress,
				readFlashAddress
			]
		];

		var expectedDirections = [
			[
				driver_const.LJM_WRITE,
				driver_const.LJM_READ
			],
			[
				driver_const.LJM_WRITE,
				driver_const.LJM_READ
			]
		];

		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);
		testDevice.setNextValue(expectedMemory);

		labjack_t7_upgrade.readFlash(testBundle, paramAddress1, length, size)
		.then(function (actualMemory) {
			test.deepEqual(testDevice.getLastAddress(), expectedAddresses);
			test.deepEqual(testDevice.getLastValue(), expectedValues);
			test.deepEqual(testDevice.getLastDirections(), expectedDirections);
			test.deepEqual(actualMemory, expectedReturnMemory);
			test.done();
		}, function(err) { test.ok(false, err); test.done(); });
	},

	testReadImage: function(test)
	{
		var sizePerOperation = driver_const.T7_FLASH_BLOCK_WRITE_SIZE; 
		var pageSize = driver_const.T7_FLASH_PAGE_SIZE;
		var numPages = driver_const.T7_IMG_FLASH_PAGE_ERASE;
		var numBytesPerInt = 4;

		var intsPerPage = pageSize / numBytesPerInt;
		var expectedIntsReturned = numPages * intsPerPage;
		var expectedRWOps = expectedIntsReturned / sizePerOperation;
		var expectedReadAddr = driver_const.T7_EFAdd_ExtFirmwareImage;

		var createZeroArray = function (numZeros)
		{
			var retVal = [];
			for(var i=0; i<numZeros; i++)
				retVal.push(0);
			return retVal;
		}

		var mockMemory = [];
		for(i=0; i<expectedRWOps; i++)
		{
			mockMemory.push(createZeroArray(sizePerOperation));
		}
		
		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);
		testDevice.setNextValue(mockMemory);

		labjack_t7_upgrade.readImage(testBundle).then(function (actualMemory) {
			var lastValues = testDevice.getLastValue();
			test.equal(actualMemory.length, expectedIntsReturned);
			test.equal(lastValues.length, expectedRWOps);
			test.equal(lastValues[0].length, 9); // 1 for ptr, 8 for data
			test.equal(lastValues[0][0], expectedReadAddr);
			test.done();
		}, function(err) { test.ok(false, err); test.done(); });
	},

	testReadImageInformation: function(test)
	{
		var sizePerOperation = driver_const.T7_FLASH_BLOCK_WRITE_SIZE; 
		var pageSize = driver_const.T7_FLASH_PAGE_SIZE;
		var numPages = driver_const.T7_HDR_FLASH_PAGE_ERASE;
		var numBytesPerInt = 4;

		var intsPerPage = pageSize / numBytesPerInt;
		var expectedIntsReturned = numPages * intsPerPage;
		var expectedRWOps = expectedIntsReturned / sizePerOperation;
		var expectedReadAddr = driver_const.T7_EFAdd_ExtFirmwareImgInfo;

		var createZeroArray = function (numZeros)
		{
			var retVal = [];
			for(var i=0; i<numZeros; i++)
				retVal.push(0);
			return retVal;
		}

		var mockMemory = [];
		for(i=0; i<expectedRWOps; i++)
		{
			mockMemory.push(createZeroArray(sizePerOperation));
		}
		
		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);
		testDevice.setNextValue(mockMemory);

		labjack_t7_upgrade.readImageInformation(testBundle)
		.then(function (actualMemory) {
			var lastValues = testDevice.getLastValue();
			test.equal(actualMemory.length, expectedIntsReturned);
			test.equal(lastValues.length, expectedRWOps);
			test.equal(lastValues[0].length, 9); // 1 for ptr, 8 for data
			test.equal(lastValues[0][0], expectedReadAddr);
			test.done();
		}, function(err) { test.ok(false, err); test.done(); });
	},

	testCheckErase: function(test)
	{
		var zeroedValue = labjack_t7_upgrade.__get__('EXPECTED_ZEROED_MEM_VAL');
		var returnConst = function () { 
			var deferred = q.defer();
			deferred.resolve([zeroedValue, zeroedValue, zeroedValue]);
			return deferred.promise;
		};

		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);

		var origReadImage = labjack_t7_upgrade.__get__('exports.readImage');
		var origReadImageInfo = labjack_t7_upgrade.__get__(
			'exports.readImageInformation');
		labjack_t7_upgrade.__set__('exports.readImage', returnConst);
		labjack_t7_upgrade.__set__('exports.readImageInformation', returnConst);
		labjack_t7_upgrade.readImageInformation(testBundle).then(function(){
			test.done();
			labjack_t7_upgrade.__set__('exports.readImage', origReadImage);
			labjack_t7_upgrade.__set__('exports.readImageInformation',
				origReadImageInfo);
		})
	},


	testWriteFlash: function(test)
	{
		var writeSize = driver_const.T7_FLASH_BLOCK_WRITE_SIZE;
		var length = writeSize*1.5;
		var size = writeSize;
		var paramAddress1 = 0;
		var paramAddress2 = 8;
		var key = 5;
		var keyAddress = driver_const.T7_MA_EXF_KEY;
		var writePtrAddress = driver_const.T7_MA_EXF_pWRITE;
		var writeFlashAddress = driver_const.T7_MA_EXF_WRITE;

		var expectedMemory = [[1], [2]];
		var expectedReturnMemory = [1, 2];

		var expectedValues = [
			[
				key,
				paramAddress1,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null
			],
			[
				key,
				paramAddress2,
				null,
				null,
				null,
				null
			]
		];

		var expectedAddresses = [
			[
				keyAddress,
				writePtrAddress,
				writeFlashAddress
			],
			[
				keyAddress,
				writePtrAddress,
				writeFlashAddress
			]
		];

		var expectedDirections = [
			[
				driver_const.LJM_WRITE,
				driver_const.LJM_WRITE,
				driver_const.LJM_WRITE
			],
			[
				driver_const.LJM_WRITE,
				driver_const.LJM_WRITE,
				driver_const.LJM_WRITE
			]
		];

		var expectedNumFrames = [3, 3];

		var expectedNumValues = [
			[1, 1, writeSize],
			[1, 1, writeSize*0.5]
		];	

		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);
		testDevice.setNextValue(expectedMemory);

		labjack_t7_upgrade.writeFlash(
			testBundle,
			paramAddress1,
			length,
			size, 
			key
		).then(function () {
			test.deepEqual(testDevice.getLastAddress(), expectedAddresses);
			test.deepEqual(testDevice.getLastValue(), expectedValues);
			test.deepEqual(testDevice.getLastDirections(), expectedDirections);
			test.deepEqual(testDevice.getLastNumValues(),
				expectedNumValues);
			test.deepEqual(testDevice.getLastFrames(), expectedNumFrames);
			test.done();
		}, function(err) { test.ok(false, err); test.done(); });
	},


	testWriteImage: function(test)
	{
		var sizePerOperation = driver_const.T7_FLASH_BLOCK_WRITE_SIZE; 
		var pageSize = driver_const.T7_FLASH_PAGE_SIZE;
		var numPages = driver_const.T7_IMG_FLASH_PAGE_ERASE;
		var numBytesPerInt = 4;

		var intsPerPage = pageSize / numBytesPerInt;
		var expectedIntsWritten = numPages * intsPerPage;
		var expectedRWOps = expectedIntsWritten / sizePerOperation;
		var expectedWriteAddr = driver_const.T7_EFAdd_ExtFirmwareImage;

		var createZeroArray = function (numZeros)
		{
			var retVal = [];
			for(var i=0; i<numZeros; i++)
				retVal.push(0);
			return retVal;
		}

		var mockMemory = [];
		for(i=0; i<expectedRWOps; i++)
		{
			mockMemory.push(createZeroArray(sizePerOperation));
		}
		
		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);
		testBundle.setDeviceImage(mockMemory);

		labjack_t7_upgrade.writeImage(testBundle).then(function () {
			var lastValues = testDevice.getLastValue();
			test.equal(lastValues.length, expectedRWOps);
			test.equal(lastValues[0][1], expectedWriteAddr);
			test.equal(lastValues[0].length, 10); // 1 for ptr, 1 key, 8 data
			test.done();
		}, function(err) { test.ok(false, err); test.done(); });
	},


	testWriteImageInformation: function(test)
	{
		var sizePerOperation = driver_const.T7_FLASH_BLOCK_WRITE_SIZE; 
		var pageSize = driver_const.T7_FLASH_PAGE_SIZE;
		var numPages = driver_const.T7_HDR_FLASH_PAGE_ERASE;
		var numBytesPerInt = 4;

		var intsPerPage = pageSize / numBytesPerInt;
		var expectedIntsWritten = numPages * intsPerPage;
		var expectedRWOps = expectedIntsWritten / sizePerOperation;
		var expectedWriteAddr = driver_const.T7_EFAdd_ExtFirmwareImgInfo;

		var createZeroArray = function (numZeros)
		{
			var retVal = [];
			for(var i=0; i<numZeros; i++)
				retVal.push(0);
			return retVal;
		}

		var mockMemory = [];
		for(i=0; i<expectedRWOps; i++)
		{
			mockMemory.push(createZeroArray(sizePerOperation));
		}
		
		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);
		testBundle.setDeviceImage(mockMemory);

		labjack_t7_upgrade.writeImageInformation(testBundle).then(function () {
			var lastValues = testDevice.getLastValue();
			test.equal(lastValues.length, expectedRWOps);
			test.equal(lastValues[0][1], expectedWriteAddr);
			test.equal(lastValues[0].length, 10); // 1 for ptr, 1 key, 8 data
			test.done();
		}, function (err) { test.ok(false, err); test.done(); });
	},


	testCheckImageWrite: function(test)
	{
		var sizePerOperation = driver_const.T7_FLASH_BLOCK_WRITE_SIZE; 
		var pageSize = driver_const.T7_FLASH_PAGE_SIZE;
		var numPages = driver_const.T7_HDR_FLASH_PAGE_ERASE;
		var numBytesPerInt = 4;

		var intsPerPage = pageSize / numBytesPerInt;
		var expectedIntsWritten = numPages * intsPerPage;
		var expectedRWOps = expectedIntsWritten / sizePerOperation;

		var createZeroArray = function (numZeros)
		{
			var retVal = [];
			for(var i=0; i<numZeros; i++)
				retVal.push(i+1);
			return retVal;
		}

		var mockMemory = [];
		for(i=0; i<expectedRWOps; i++)
		{
			mockMemory.push(createZeroArray(sizePerOperation));
		}
		var mockMemoryFlattened = mockMemory.reduce(function(a, b) {
		    return a.concat(b);
		});
		
		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);
		testBundle.setDeviceImage(mockMemoryFlattened);
		testDevice.setNextValue(mockMemory);

		labjack_t7_upgrade.checkImageWrite(testBundle).then(function () {
			test.done();
		}, function (err) { test.ok(false, err); test.done(); });
	},


	testCheckImageWriteFail: function(test)
	{
		var sizePerOperation = driver_const.T7_FLASH_BLOCK_WRITE_SIZE; 
		var pageSize = driver_const.T7_FLASH_PAGE_SIZE;
		var numPages = driver_const.T7_HDR_FLASH_PAGE_ERASE;
		var numBytesPerInt = 4;

		var intsPerPage = pageSize / numBytesPerInt;
		var expectedIntsWritten = numPages * intsPerPage;
		var expectedRWOps = expectedIntsWritten / sizePerOperation;

		var createZeroArray = function (numZeros)
		{
			var retVal = [];
			for(var i=0; i<numZeros; i++)
				retVal.push(i+1);
			return retVal;
		}

		var mockMemory = [];
		for(i=0; i<expectedRWOps; i++)
		{
			mockMemory.push(createZeroArray(sizePerOperation));
		}
		
		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);
		testBundle.setDeviceImage(mockMemory);
		testDevice.setNextValue(mockMemory);

		labjack_t7_upgrade.checkImageWrite(testBundle).fail(function () {
			test.done();
		});
	},


	testRestartAndUpgrade: function(test)
	{
		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);

		labjack_t7_upgrade.restartAndUpgrade(testBundle).then(function () {
			test.equal(testDevice.getLastAddress()[0], 
				driver_const.T7_MA_REQ_FWUPG);
			test.equal(testDevice.getLastValue()[0], 
				driver_const.T7_REQUEST_FW_UPGRADE);
			test.done();
		});
	},


	testCheckNewFirmwareSuccess: function(test)
	{
		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);
		testBundle.setFirmwareVersion(10);

		testDevice.setNextValue(10);

		labjack_t7_upgrade.checkNewFirmware(testBundle).then(function () {
			test.done();
		});
	},


	testCheckNewFirmwareFail: function(test)
	{
		var testDevice = new MockDevice();
		var testBundle = new DeviceFirmwareBundle();
		testBundle.setDevice(testDevice);
		testBundle.setFirmwareVersion(10);

		testDevice.setNextValue(11);

		labjack_t7_upgrade.checkNewFirmware(testBundle).fail(function () {
			test.done();
		});
	}

}

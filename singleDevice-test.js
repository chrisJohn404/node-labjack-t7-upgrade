var deviceUpgrader = require('./labjack_t7_upgrade');

// Firmware file location:
var loc = "/Users/chrisjohnson/Dropbox/LabJack-Shared/Calibration T7 firmware versions/T7firmware_010067_2014-02-24.bin"

//Create instance of deviceManager
var labjack = require('labjack-nodejs').device;
var device = new labjack();

//Open a device
device.openSync("LJM_dtT7", "LJM_ctEthernet", "470010117");
device.writeSync("POWER_WIFI", 0);
deviceUpgrader.updateFirmware(device,loc);

"use strict";

var expect = require('chai').expect;
var saveUsers = require('../ModUsers').saveUsers;
var fs = require('fs-extra');
var jsonfile = require('jsonfile');

const fileName = "test.file.json";
const fileData = {
    test: "json",
    object: ''
};

describe('saveUsers()', function () {
    it('should write json to file', function () {
        let testDir = fs.mkdtempSync('testOutput_');
        let path = testDir + '/' + fileName;

        return saveUsers(path, fileData)
            .then(function (err) {
                console.log("Testing that there are no errors...");
                expect(err).to.be.undefined;

                console.log("Testing that file exists...");
                expect(fs.existsSync(path)).to.be.true;

                var readData = jsonfile.readFileSync(path);
                console.log("Testing integrity of written data...");
                expect(readData).to.deep.equal(fileData);
            })
            .then(function () {
                console.log("Removing created temporary folder: " + testDir + "...");
                fs.removeSync(testDir)
            });
    });

    it('should save archived backup if file already exists', function () {
        let testDir = fs.mkdtempSync('testOutput_');
        const path = testDir + '/' + fileName;

        return saveUsers(path, fileData)
            .then(() => saveUsers(path, fileData)) // if file exists, archive must be called.
            .then(function () {
                console.log("Checking archive presence...");
                let archivePath = testDir + '/' + fileName + '.0.tar.gz';
                console.log("Looking for archive: " + archivePath);
                expect(fs.existsSync(archivePath), "Archive exists: " + archivePath).to.be.true
            })
            .then(function () {
                console.log("Removing created temporary folder: " + testDir + "...");
                fs.removeSync(testDir)
            });
    });

    it('should throw an error if file saving fails');

    it('should not overwrite valid data if file saving fails', function () {
        let testDir = fs.mkdtempSync('testOutput_');
        const path = testDir + '/' + fileName;

        return saveUsers(path, fileData)
            .then(() => saveUsers(path, fileData)) // if file exists, archive must be called.
            .then(function () {
                console.log("Checking archive presence...");
                let archivePath = testDir + '/' + fileName + '.0.tar.gz';
                console.log("Looking for archive: " + archivePath);
                expect(fs.existsSync(archivePath), "Archive exists: " + archivePath).to.be.true
            })
            .then(function () {
                console.log("Removing created temporary folder: " + testDir + "...");
                fs.removeSync(testDir)
            });
    });

});
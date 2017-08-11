/* DO NOT RUN AT THE SAME TIME AS ROWBOAT! */

var fs = require('fs');
var jsonfile = require('jsonfile');

const INDEXFILE = 'index.json';
const DOWNLOADPATH = 'songs';

var index = null;

function loadIndex() {
    var indexfile = DOWNLOADPATH + '/' + INDEXFILE;
 
    try {
        fs.accessSync(indexfile, fs.F_OK);
    } catch (e) {
        jsonfile.writeFileSync(indexfile, {});
    }

    try {
        index = jsonfile.readFileSync(indexfile);
    } catch (e) {
        return false;
    }
    if (!index) index = {};
        
    return true;
}

function saveIndex() {
    var indexfile = DOWNLOADPATH + '/' + INDEXFILE;
    
    jsonfile.writeFileSync(indexfile, index, {spaces: 4});
}

if (!loadIndex()) {
    console.log('Failed to load index.');
    return;
}

console.log('Loaded index.');

for (let hash in index) {
    let realpath = DOWNLOADPATH + '/' + hash + '.mp3';
    if (!fs.existsSync(realpath)) {
        console.log('Removing missing song from index: ' + hash + ' (' + index[hash].name + ').');
        delete index[hash];
    }
}

saveIndex();

console.log('Saved index.');

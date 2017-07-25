/* DO NOT RUN AT THE SAME TIME AS ROWBOAT! */

var fs = require('fs');
var jsonfile = require('jsonfile');

const INDEXFILE = 'index.json';
const DOWNLOADPATH = 'songs';

var index = null;

loadIndex() {
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

saveIndex() {
    var indexfile = DOWNLOADPATH + '/' + INDEXFILE;
    
    jsonfile.writeFileSync(indexfile, index, {spaces: 4});
}

if (!loadIndex()) {
    console.log('Failed to load index.');
    return;
}

console.log('Loaded index.');

for (let hash in index) {
    if (!index[hash].like) continue;
    console.log(hash);
    let likes = index[hash].like;
    for (userid in likes) {
        if (likes[userid] == 1) {
            likes[userid] = 2;
            console.log('  -- ' + userid + ': 1 -> 2');
        } else if (likes[userid] == 0) {
            likes[userid] = 1;
            console.log('  -- ' + userid + ': 0 -> 1');
        }
    }
    index[hash].like = likes;
}

saveIndex();

console.log('Saved index.');

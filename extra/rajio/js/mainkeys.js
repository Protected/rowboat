//Due to browsers arbitrarily ignoring event.stopPropagation, we use these event queues for handling keypress hierarchies.

document.spaKeypressCallbacks = {
    13: [], //Enable ENTER
    27: []  //Enable ESCAPE
};

function onSpaKeypressFirst(key, callback, tag) {
    return onSpaKeypress(key, true, callback, tag);
}

function onSpaKeypressLast(key, callback, tag) {
    return onSpaKeypress(key, false, callback, tag);
}

function onSpaKeypress(key, isfirst, callback, tag) {
    if (!key || typeof key != "number" || typeof document.spaKeypressCallbacks[key] != "object" || typeof callback != "function") return false;
    if (isfirst) {
        document.spaKeypressCallbacks[key].unshift([callback, tag]);
        return 1;
    } else {
        document.spaKeypressCallbacks[key].push([callback, tag]);
        return document.spaKeypressCallbacks[key].length;
    }
}

function onSpaKeyEnter(callback, tag) {
    return onSpaKeypressFirst(13, callback, tag);
}

function onSpaKeyEscape(callback, tag) {
    return onSpaKeypressFirst(27, callback, tag);
}

function offSpaKeypress(key, callback) {
    if (!key || typeof key != "number" || typeof document.spaKeypressCallbacks[key] != "object" || typeof callback != "function") return false;
    for (var i = 0; i < document.spaKeypressCallbacks[key].length; i++) {
        if (document.spaKeypressCallbacks[key][i][0] == callback) {
            document.spaKeypressCallbacks[key] == document.spaKeypressCallbacks[key].splice(i, 1);
            break;
        }
    }
    return true;
}

function offSpaKeyEnter(callback) {
    return offSpaKeypress(13, callback);
}

function offSpaKeyEscape(callback) {
    return offSpaKeypress(27, callback);
}

function removeSpaKeypressesByTag(tag, key) {
    if (!tag) return false;
    for (var ikey in document.spaKeypressCallbacks) {
        if (key && key != ikey) continue;
        for (var j = 0; j < document.spaKeypressCallbacks[ikey].length; j++) {
            if (document.spaKeypressCallbacks[ikey][j][1] == tag) {
                document.spaKeypressCallbacks[ikey] == document.spaKeypressCallbacks[ikey].splice(j, 1);
                j -= 1;
            }
        }
    }
    return true;
}

$(function(){
    $('body').on('keydown', function(event) {
        var callbacks = null;
    
        for (var key in document.spaKeypressCallbacks) {
            if (key == event.which) {
                callbacks = document.spaKeypressCallbacks[key];
                break;
            }
        }
        
        var bubble = true;
        
        if (callbacks) {
            for (var i = 0; i < callbacks.length; i++) {
                if (!callbacks[i][0](event, i)) {
                    bubble = false;
                    break;
                }
            }
        }
        
        if (!bubble) {
            event.stopPropagation();
            event.preventDefault();
            return false;
        }
    });
});

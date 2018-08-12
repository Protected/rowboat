document.spaAjaxInProgress = 0;
document.spaAjaxHandlers = {};
document.spaAjaxThinkStarters = {};
document.spaAjaxTransactionId = 0;

function spaAjax(filename, request, successCallback, replaceoptions) {

    var url = 'ajax.php?s=' + filename;

    var id = ++document.spaAjaxTransactionId;
    document.spaAjaxTransactionId = id;
    
    var trycallerid = setInterval(function(){

        if (document.spaAjaxLocked) return;
        document.spaAjaxLocked = true;
    
        var options = $.extend({
            thoughtless: false,
            halfassed: false,
            onError: null
        }, replaceoptions);

        document.spaAjaxInProgress += 1;
        
        if (!options.thoughtless && !options.halfassed) {
            document.spaAjaxThinkStarters[id] = setTimeout(function(){
                enableLoadLayer();
            }, 1000);
        } else if (options.halfassed) {
            enableLoadHalfAssed();
        }
        
        document.spaAjaxHandlers[id] = $.post(url, request, function(data) {
        
            var trycloserid = setInterval(function(){
            
                if (document.spaAjaxLocked) return;
                document.spaAjaxLocked = true;
        
                delete document.spaAjaxHandlers[id];
                if (document.spaAjaxThinkStarters[id]) clearTimeout(document.spaAjaxThinkStarters[id]);
                
                if (!options.thoughtless && !options.halfassed) softDisableLoadLayer();
                if (options.halfassed) disableLoadHalfAssed();
                
                if (data && data.r) {
                    if (successCallback) successCallback(data);
                    document.spaAjaxInProgress -= 1;
                    if (document.spaAjaxInProgress < 0) document.spaAjaxInProgress = 0;
                } else if (data && data.errno == -1) {
                    location.href = '?d=';
                } else if (data && data.errno) {
                    document.spaAjaxInProgress -= 1;
                    if (document.spaAjaxInProgress < 0) document.spaAjaxInProgress = 0;
                    var showalert = true;
                    if (options.onError) {
                        showalert = options.onError(data.errno);
                    }
                    if (showalert) {
                        setTimeout(function(){
                            alert('(' + data.errno + ') ' + data.error, null);
                        }, 100);
                    }
                }
                
                delete document.spaAjaxLocked;
                clearInterval(trycloserid);
                
            }, 250);
                
        }, 'json');
        
        delete document.spaAjaxLocked;
        clearInterval(trycallerid);
        
    }, 250);
    
    return id;
}

function spaAjaxAbort(id) {
    if (!document.spaAjaxHandlers[id]) return false;
    
    document.spaAjaxHandlers[id].abort();
    delete document.spaAjaxHandlers[id];
    
    clearTimeout(document.spaAjaxThinkStarters[id]);
    delete document.spaAjaxThinkStarters[id];
    
    document.spaAjaxInProgress -= 1;
    if (document.spaAjaxInProgress < 0) document.spaAjaxInProgress = 0;
    
    if (Object.keys(document.spaAjaxHandlers).length == 0) {
        if (document.spinner) {
            document.spinner.stop();
            document.spinner = null;
        }
        $('#thinklayer')[0].style.display = 'none';
        disableLoadHalfAssed();
    }
    return true;
}

document.spinner = null;

function addSpin(id) {
    var opts = {
      lines: 15, // The number of lines to draw
      length: 37, // The length of each line
      width: 5, // The line thickness
      radius: 30, // The radius of the inner circle
      corners: 0, // Corner roundness (0..1)
      rotate: 0, // The rotation offset
      direction: 1, // 1: clockwise, -1: counterclockwise
      color: '#000', // #rgb or #rrggbb or array of colors
      speed: 1, // Rounds per second
      trail: 71, // Afterglow percentage
      shadow: false, // Whether to render a shadow
      hwaccel: false, // Whether to use hardware acceleration
      className: 'spinner', // The CSS class to assign to the spinner
      zIndex: 1505, // The z-index
      top: '50%', // Top position relative to parent
      left: '50%' // Left position relative to parent
    };
    var target = $('#' + id);
    if (!target.length) return null;
    var spinner = new Spinner(opts).spin(target[0]);
    return spinner;
}

function addLittleSpin(id) {
    var opts = {
      lines: 10, // The number of lines to draw
      length: 2, // The length of each line
      width: 3, // The line thickness
      radius: 6, // The radius of the inner circle
      corners: 0.5, // Corner roundness (0..1)
      rotate: 0, // The rotation offset
      direction: 1, // 1: clockwise, -1: counterclockwise
      color: '#fff', // #rgb or #rrggbb or array of colors
      speed: 1, // Rounds per second
      trail: 71, // Afterglow percentage
      shadow: false, // Whether to render a shadow
      hwaccel: false, // Whether to use hardware acceleration
      className: 'spinner', // The CSS class to assign to the spinner
      zIndex: 1504, // The z-index
      top: '50%', // Top position relative to parent
      left: '50%' // Left position relative to parent
    };
    var target = $('#' + id);
    if (!target.length) return null;
    var spinner = new Spinner(opts).spin(target[0]);
    return spinner;
}

function enableLoadLayer() {
    if (!document.spinner) {
        document.spinner = addSpin('thinklayer');
    }
    $('#thinklayer')[0].style.display = 'block';
    onSpaKeyEscape(function loadlayerclosekey(event) {
        disableLoadLayer();
        offSpaKeyEscape(loadlayerclosekey);
        return false;
    });
}

function disableLoadLayer() {
    if (document.spinner) {
        document.spinner.stop();
        document.spinner = null;
    }
    $('#thinklayer')[0].style.display = 'none';
    for (var id in document.spaAjaxHandlers) {
        document.spaAjaxHandlers[id].abort();
        clearTimeout(document.spaAjaxThinkStarters[id]);
    }
    document.spaAjaxHandlers = {};
    document.spaAjaxThinkStarters = {};
    document.spaAjaxInProgress = 0;
}

function softDisableLoadLayer() {
    var haskeys = false;
    for (var key in document.spaAjaxHandlers) {
        if (typeof document.spaAjaxHandlers[key] != "function") {
            haskeys = true;
            break;
        }
    }
    if (haskeys) return;  //If there is any pending handler, do not disable load layer
    disableLoadLayer();
}

function enableLoadHalfAssed() {
    if (!document.littlespinner) {
        document.littlespinner = addLittleSpin('littlespin');
    }
    $('#littlespin')[0].style.display = 'block';
}

function disableLoadHalfAssed() {
    if (document.littlespinner) {
        document.littlespinner.stop();
        document.littlespinner = null;
    }
    $('#littlespin')[0].style.display = 'none';
}

$(function(){
    $('#thinklayer > a.abortbutton').click(function(){
        disableLoadLayer();
        return false;
    });
});

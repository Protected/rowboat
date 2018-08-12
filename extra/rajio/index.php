<?php

require_once("config.inc.php");

?>

<html>
<head>

<title>Rajio library contents</title>

<meta http-equiv="X-UA-Compatible" content="IE=Edge">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta http-equiv="CACHE-CONTROL" CONTENT="NO-CACHE">
<meta http-equiv="PRAGMA" CONTENT="NO-CACHE">

<link rel="stylesheet" type="text/css" href="css/base.css">
<link rel="stylesheet" type="text/css" href="css/datatables.min.css"></link>

<script type="text/javascript" src="js/jquery.js"></script>
<script type="text/javascript" src="js/mainkeys.js"></script>
<script type="text/javascript" src="js/spin.js"></script>
<script type="text/javascript" src="js/ajax.js"></script>
<script type="text/javascript" src="js/datatables.min.js"></script>

</head>
<body>

<div id="thinklayer"><a href="#" class="abortbutton">Abort operation</a></div>

<div id="keywords">
    <a class="close" href="#" onclick="closeKeywords(); return false;">✕</a>
    <div class="song"></div>
    <ul></ul>
</div>

<div id="userstats">
    <a class="close" href="#" onclick="closeUserstats(); return false;">✕</a>
    <div class="avatar"></div>
    <div class="username"></div>
    
    <div class="statlist">
        <div class="statrow">
            <div class="label" title="Amount of shared songs indexed in the library">Shares</div>
            <div class="contents shares"></div>
        </div>
        <div class="statrow">
            <div class="label" title="Length of the shortest shared song">Shortest share length</div>
            <div class="contents shareminlength"></div>
        </div>
        <div class="statrow">
            <div class="label" title="Average of the lengths of all shared songs">Average share length</div>
            <div class="contents shareavglength"></div>
        </div>
        <div class="statrow">
            <div class="label" title="Length of the longest shared song">Longest share length</div>
            <div class="contents sharemaxlength"></div>
        </div>
        <div class="statrow">
            <div class="label" title="All opinions the user registered in the index">User's opinions</div>
            <div class="contents likes"></div>
        </div>
        <div class="statrow">
            <div class="label" title="Blind average of all of the user's opinions">Average opinion</div>
            <div class="contents likesavg"></div>
        </div>
        <div class="statrow">
            <div class="label" title="Average of the user's opinions excluding default likes on shared songs">Average modified opinion</div>
            <div class="contents likesmodavg"></div>
        </div>
        <div class="statrow">
            <div class="label" title="All opinions registered by all users on this user's shared songs">Opinions on user's shares</div>
            <div class="contents likesonshares"></div>
        </div>
        <div class="statrow">
            <div class="label" title="Blind average of all opinions on the user's shared songs">Average likeability</div>
            <div class="contents likesonsharesavg"></div>
        </div>
        <div class="statrow">
            <div class="label" title="Average of the opinions on the user's songs excluding default likes on shared songs">Average modified likeability</div>
            <div class="contents likesonsharesmodavg"></div>
        </div>
    </div>
</div>

<div id="wrapper">

    <div id="header"></div>

    <table id="library">
        <thead>
            <tr>
                <th class="c_format"></th>
                <th class="c_hash">Hash</th>
                <th>Name</th>
                <th>Author</th>
                <th class="c_album">Album</th>
                <th class="c_length">Length</th>
                <th class="c_sharedby">Shared by</th>
                <th class="c_pl">PL</th>
                <th class="c_lastplayed">Last played</th>
                <th class="c_kw">KW</th>
                <th class="c_likes">Likes</th>
                <th class="c_pri">LP</th>
            </tr>
        </thead>
        <tbody></tbody>
    </table>
    
</div>

<script type="text/javascript">

let likesymbols = <?=json_encode($likesymbols)?>;

let userstats = {};

let maxlma = -3;
let maxlmauserid = [];
let minlma = 3;
let minlmauserid = [];
let maxlosma = -3;
let maxlosmauserid = [];
let minlosma = 3;
let minlosmauserid = [];

let maxshares = 1;
let maxsharesuserid = [];

let minsal = null;
let minsaluserid = [];
let maxsal = null;
let maxsaluserid = [];


let columndefs = [
    {targets: [0], className: "c_format", render: (data, type, row, meta) => type == "display" ? '<span class="' + row.format + '" title="' + row.format + '"></span>' : row.format},
    {targets: [1], className: "c_hash hashcell", orderable: false, render: (data, type, row, meta) => type == "display" ? '<input type="text" value="' + row.hash + '" readonly>' : row.hash},
    {targets: [2], render: (data, type, row, meta) => type == "display" ? '<a href="' + row.source + '" target="_blank">' + row.name + '</a>' : row.name},
    {targets: [3], render: (data, type, row, meta) => type == "display" ? '<a href="https://duckduckgo.com/?q=' + row.urlauthor + '" target="_blank">' + row.author + '</a>' : row.author},
    {targets: [4], className: "c_album", render: (data, type, row, meta) => type == "display" ? '<a href="https://duckduckgo.com/?q=' + row.urlalbum + '" target="_blank">' + row.album + '</a>' : row.album},
    {targets: [5], className: "c_length ra", render: (data, type, row, meta) => type == "display" ? row.length : row.paddedlength},
    {targets: [6], className: "c_sharedby", render: (data, type, row, meta) => {
        if (type == "filter") return row.allsharers;
        let sharername = (userstats[row.sharedBy] ? userstats[row.sharedBy].displayname : row.sharedBy);
        if (type != "display") return sharername;
        return '<a href="#" onclick="openUserstats(\'' + row.sharedBy + '\'); return false;" title="' + row.allsharers + '">' + sharername + '</a>';
    }},
    {targets: [7], className: "c_pl ra", render: (data, type, row, meta) => row.plays},
    {targets: [8], className: "c_lastplayed ra", render: (data, type, row, meta) => type == "display" ? row.lastplayed : row.paddedlastplayed},
    {targets: [9], className: "c_kw ra fade", render: (data, type, row, meta) => {
        if (type == "filter") return row.kwlist.join(",");
        if (type != "display") return row.kw;
        return '<a href="#" onclick=\'openKeywords("' + row.name + '", ' + JSON.stringify(row.kwlist) + ', this); return false;\'>' + row.kw + '</a>';
    }},
    {targets: [10], className: "c_likes emoji", render: (data, type, row, meta) => {
        if (type == "filter") return row.likefilterstring;
        if (type != "display") return row.likenum;
        return row.likestring;
    }},
    {targets: [11], className: "c_pri ra fade", render: (data, type, row, meta) => type == "display" ? row.priority : row.prioritymeta},
];


$(() => {
    loadUserstats(() => {

        let totalLength;

        $('#library')
            .on("xhr.dt", (e, settings, data, xhr) => {
                totalLength = data.totalLength;
            })
            .dataTable({
                autoWidth: false,
                paging: false,
                dom: "ift",
                serverSide: true,
                ajax: "ajax.php?s=library",
                order: [[2, "asc"]],
                columnDefs: columndefs,
                language: {
                    search: '',
                    info: 'Rajio Library - _TOTAL_ songs'
                },
                search: {
                    smart: false,
                    caseInsensitive: true
                },
                searchDelay: 500,
                createdRow: (tr, row, dataIndex, cells) => {
                    $(tr).find('.hashcell > input').click(function () {
                        $(this).select();
                    });
                },
                infoCallback: (settings, start, end, max, total, pre) => {
                    return pre + " - " + totalLength;
                }
            });

    });

});


function minutesAndSeconds(seconds) {
    let m = Math.floor(seconds / 60);
    let s = seconds % 60;
    s = s.toFixed(0);
    if (s.length < 2) s = "0" + s;
    return m + ":" + s;
}



//Keywords


let kwreposition = null;

function openKeywords(song, keywords, node) {
    $('#keywords > .song').text(song);
    $('#keywords > ul').html('');
    let i = 0;
    for (let keyword of keywords) {
        $('#keywords > ul').append('<li class="' + (i % 2 ? 'odd' : 'even') + '">' + keyword + '</li>');
        i += 1;
    }
    
    if (kwreposition) $(window).off('resize', kwreposition);
    kwreposition = () => {
        let pos = $(node).offset();
        pos.left -= $('#keywords').width();
        if (pos.top + $('#keywords').height() > $('body').height()) {
            pos.top -= $('#keywords').height();
        }
        $('#keywords').css(pos);
    }
    kwreposition();
    $(window).resize(kwreposition);
    
    $('#keywords').show();
}

function closeKeywords() {
    if (kwreposition) $(window).off('resize', kwreposition);
    kwreposition = null;
    $('#keywords').hide();
}



//User stats


function loadUserstats(then) {
    spaAjax('misc', {}, (data) => {

        userstats = data.userstats;

        for (let userid in userstats) {

            let avg = 0;
            let total = 0;
            for (let likeability in userstats[userid].likes) {
                avg += userstats[userid].likes[likeability] * likeability;
                total += userstats[userid].likes[likeability];
            }
            userstats[userid].likesavg = (avg / total).toFixed(2);
            userstats[userid].likesmodavg = ((avg - (userstats[userid].likeshares || 0)) / total).toFixed(2);
            
            avg = 0;
            total = 0;
            for (let likeability in userstats[userid].likesonshares) {
                avg += userstats[userid].likesonshares[likeability] * likeability;
                total += userstats[userid].likesonshares[likeability];
            }
            userstats[userid].likesonsharesavg = (avg / total).toFixed(2);
            userstats[userid].likesonsharesmodavg = ((avg - (userstats[userid].likeshares || 0)) / total).toFixed(2);
            
            
            if (!userstats[userid].shares || userstats[userid].shares < 20) continue;  //Does not count for 'tags'
            
            
            if (userstats[userid].shares > maxshares) {
                maxshares = userstats[userid].shares;
                maxsharesuserid = [userid];
            } else if (userstats[userid].shares == maxshares) {
                maxsharesuserid.push(userid);
            }
            
            if (userstats[userid].shareavglength > 0) {
                if (!minsal || userstats[userid].shareavglength < minsal) {
                    minsal = userstats[userid].shareavglength;
                    minsaluserid = [userid];
                } else if (userstats[userid].shareavglength == minsal) {
                    minsaluserid.push(userid);
                }
                
                if (!maxsal || userstats[userid].shareavglength > maxsal) {
                    maxsal = userstats[userid].shareavglength;
                    maxsaluserid = [userid];
                } else if (userstats[userid].shareavglength == maxsal) {
                    maxsaluserid.push(userid);
                }
            }
            
            if (userstats[userid].likesmodavg > maxlma) {
                maxlma = userstats[userid].likesmodavg;
                maxlmauserid = [userid];
            } else if (userstats[userid].likesmodavg == maxlma) {
                maxlmauserid.push(userid);
            }
            
            if (userstats[userid].likesmodavg < minlma) {
                minlma = userstats[userid].likesmodavg;
                minlmauserid = [userid];
            } else if (userstats[userid].likesmodavg == minlma) {
                minlmauserid.push(userid);
            }
            
            if (userstats[userid].likesonsharesmodavg > maxlosma) {
                maxlosma = userstats[userid].likesonsharesmodavg;
                maxlosmauserid = [userid];
            } else if (userstats[userid].likesonsharesmodavg == maxlosma) {
                maxlosmauserid.push(userid);
            }
            
            if (userstats[userid].likesonsharesmodavg < minlosma) {
                minlosma = userstats[userid].likesonsharesmodavg;
                minlosmauserid = [userid];
            } else if (userstats[userid].likesonsharesmodavg == minlosma) {
                minlosmauserid.push(userid);
            }

        }
        
        if (then) then(data);
        
    });

}

function openUserstats(userid) {
    if (!userstats[userid]) return;

    $('#userstats .username').text(userstats[userid].displayname);
    if (userstats[userid].avatar) {
        $('#userstats .avatar').css('background-image', 'url(\'' + userstats[userid].avatar + '\')');
    } else {
        $('#userstats .avatar').css('background-image', 'none');
    }
    
    $('#userstats .shares').html('<div class="inner">' + userstats[userid].shares + '</div>');
    if (maxsharesuserid.indexOf(userid) > -1) {
        $('#userstats .shares').append('<div class="labelunit good">Most shares</div>');
    }
    
    $('#userstats .shareminlength').html('<div class="inner">' + minutesAndSeconds(userstats[userid].shareminlength) + '</div>');
    
    $('#userstats .shareavglength').html('<div class="inner">' + minutesAndSeconds(userstats[userid].shareavglength) + '</div>');
    if (minsaluserid.indexOf(userid) > -1) {
        $('#userstats .shareavglength').append('<div class="labelunit">Shortest average length</div>');
    }
    if (maxsaluserid.indexOf(userid) > -1) {
        $('#userstats .shareavglength').append('<div class="labelunit">Longest average length</div>');
    }
    
    $('#userstats .sharemaxlength').html('<div class="inner">' + minutesAndSeconds(userstats[userid].sharemaxlength) + '</div>');
    
    $('#userstats .likesavg').html('<div class="inner">' + userstats[userid].likesavg + '</div>');
    
    $('#userstats .likesonsharesavg').html('<div class="inner">' + userstats[userid].likesonsharesavg + '</div>');
    
    $('#userstats .likesmodavg').html('<div class="inner">' + userstats[userid].likesmodavg + '</div>');
    if (minlmauserid.indexOf(userid) > -1) {
        $('#userstats .likesmodavg').append('<div class="labelunit bad">Most close-minded</div>');
    }
    if (maxlmauserid.indexOf(userid) > -1) {
        $('#userstats .likesmodavg').append('<div class="labelunit good">Most open-minded</div>');
    }
    
    $('#userstats .likesonsharesmodavg').html('<div class="inner">' + userstats[userid].likesonsharesmodavg + '</div>');
    if (minlosmauserid.indexOf(userid) > -1) {
        $('#userstats .likesonsharesmodavg').append('<div class="labelunit bad">Most unpopular taste</div>');
    }
    if (maxlosmauserid.indexOf(userid) > -1) {
        $('#userstats .likesonsharesmodavg').append('<div class="labelunit good">Most popular taste</div>');
    }
    
    if (userstats[userid].likes) {
    
        let likeblock = '';
        for (let likeability in userstats[userid].likes) {
            if (!likesymbols[likeability]) continue;
            likeblock += '<div class="likeunit"><span title="' + likeability + '">' + likesymbols[likeability] + '</span>' + userstats[userid].likes[likeability] + '</div>';
        }
        $('#userstats .likes').html(likeblock);
        
        likeblock = '';
        for (let likeability in userstats[userid].likesonshares) {
            if (!likesymbols[likeability]) continue;
            likeblock += '<div class="likeunit"><span title="' + likeability + '">' + likesymbols[likeability] + '</span>' + userstats[userid].likesonshares[likeability] + '</div>';
        }        
        $('#userstats .likesonshares').html(likeblock);
        
    } else {
        $('#userstats .likes').html('');
        $('#userstats .likesonshares').html('');
    }
    
    $('#userstats').show();
}

function closeUserstats() {
    $('#userstats').hide();
}


</script>

</body>
</html>

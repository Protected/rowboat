<?php

$path = "/path/to/index.json";
$instancename = "rajio";
$likesymbols = [
    2 => '👌',
    1 => '🙂',
    -1 => '🤢',
    -2 => '💩'
];

?>

<html>
<head>
<title>Rajio library contents</title>
<link rel="stylesheet" type="text/css" href="datatables.min.css"></link>
<style type="text/css">
body {
    padding: 0;
    margin: 0;
    font-family: monospace;
    font-size: 0.65vw;
}
a, a:visited {
    color: #0000df;
    text-decoration: none;
}
a:hover {
    text-decoration: underline;
}
table#library, input {
    font-family: monospace;
    border-collapse: collapse;
    width: 100%;
}

table#library th {
    text-align: left;
    border-bottom: 2px solid black;
}
table#library th.sorting_asc {
    text-decoration: underline;
}
table#library th.sorting_desc {
    text-decoration: overline;
}

table#library tr.odd {
    background-color: #e0e0ff;
}
table#library tr.even {
    background-color: #f0f0ff;
}

table#library th, table#library td {
    padding: 5px;
    font-size: 0.65vw;
}
table#library .ra {
    text-align: right;
}
.meta {
    display: none;
}
.emoji > span {
    display: inline-block;
    width: 0.9vw;
    text-align: center;
}
.hashcell > input {
    border: none;
    background: none;
    width: 100%;
    padding: 0 2px;
    font-family: inherit;
    font-size: inherit;
}

#keywords {
    display: none;
    
    position: absolute;
    z-index: 100;
    background: white;
    border: 1px solid #001030;
    border-radius: 5px;
    padding: 2px;
    
    overflow: hidden;
    
    width: 15vw;
    height: 20vh;
}
#keywords > .close {
    display: block;
    float: right;
    font-weight: bold;
}
#keywords > .song {
    border-bottom: 1px solid black;
    margin-bottom: 2px;
    padding: 3px;
}
#keywords > ul {
    clear: both;
    padding: 0;
    margin: 0;
    display: block;
    overflow: auto;
    position: absolute;
    top: 2.65vh;
    bottom: 0;
    left: 0;
    right: 0;
}
#keywords > ul > li {
    display: block;
    padding: 3px;
    position: relative;
    left: 0; right: 0;
}
#keywords > ul > li.odd {
    background-color: #e0ffe0;
}
#keywords > ul > li.even {
    background-color: #f0fff0;
}
</style>
<script type="text/javascript" src="datatables.min.js"></script>
</head>
<body>

<?

$index = json_decode(file_get_contents($path), true);
$sorted = array_values($index);
/*usort($sorted, function ($a, $b) {
    return strcmp($a["name"], $b["name"]);
});*/


function minutesAndSeconds($seconds) {
    $m = floor($seconds / 60);
    $s = $seconds % 60;
    return $m . ":" . str_pad($s, 2, "0", STR_PAD_LEFT);
}

function ago($ts) {
    if (!$ts) return "never";
    $delay = time() - $ts;
    $days = floor($delay / 86400);
    $hours = str_pad(floor(($delay % 86400) / 3600), 2, "0", STR_PAD_LEFT);
    $minutes = str_pad(floor(($delay % 3600) / 60), 2, "0", STR_PAD_LEFT);
    $seconds = str_pad($delay % 60, 2, "0", STR_PAD_LEFT);
    return ($days ? $days . "d " : "") . $hours . ":" . $minutes . ":" . $seconds;
}

?>

<div id="keywords">
    <a class="close" href="#" onclick="closeKeywords(); return false;">✕</a>
    <div class="song"></div>
    <ul></ul>
</div>

<table id="library">
    <thead>
        <tr>
            <th style="width: 12vw;">Hash</th>
            <th>Name</th>
            <th>Author</th>
            <th>Album</th>
            <th style="width: 2vw;">Length</th>
            <th style="width: 2vw;">PL</th>
            <th style="width: 5vw;">Last played</th>
            <th style="width: 2vw;">KW</th>
            <th style="width: 6vw;">Likes</th>
        </tr>
    </thead>
    <tbody>
        <?
            foreach ($sorted as $i => $info) {
            
                $likestring = "";
                if (isset($info["like"])) foreach ($info["like"] as $userid => $lik) {
                    $likestring .= '<span title="' . $lik . '">' . $likesymbols[$lik] . '</span>';
                }
                
                $plength = str_pad($info["length"], 5, "0", STR_PAD_LEFT);
                
                $keywords = array_map(function($keyword) { return htmlspecialchars(str_replace("'", "", $keyword)); }, $info["keywords"]);
                
                $info["name"] = htmlspecialchars($info["name"]);
                $info["author"] = htmlspecialchars($info["author"]);
                $info["album"] = htmlspecialchars($info["album"] ?? "");
                
                $lastplayedmeta = PHP_INT_MAX;
                if (isset($info[$instancename . ".rajio.lastplayed"])) {
                    $lastplayedmeta = str_pad($info[$instancename . ".rajio.lastplayed"], strlen(PHP_INT_MAX), "0", STR_PAD_LEFT);
                }
                
                ?><tr class="<?=($i % 2 ? "odd" : "even")?>">
                    <td class="hashcell"><input type="text" value="<?=$info["hash"]?>"></td>
                    <td><span class="meta"><?=$info["name"]?></span><a href="<?=$info["source"]?>" target="_blank"><?=$info["name"]?></a></td>
                    <td><span class="meta"><?=$info["author"]?></span><a href="https://duckduckgo.com/?q=<?=urlencode($info["author"])?>" target="_blank"><?=$info["author"]?></a></td>
                    <td><span class="meta"><?=$info["album"]?></span><a href="https://duckduckgo.com/?q=<?=urlencode($info["album"])?>" target="_blank"><?=$info["album"]?></a></td>
                    <td><span class="meta"><?=$plength?></span><?=minutesAndSeconds($info["length"])?></td>
                    <td><?=($info[$instancename . ".rajio.plays"] ?? 0)?></td>
                    <td><span class="meta"><?=$lastplayedmeta?></span>
                        <?=ago($info[$instancename . ".rajio.lastplayed"] ?? 0)?></td>
                    <td><span class="meta"><?=str_pad(count($info["keywords"] ?? []), 4, "0", STR_PAD_LEFT)?></span><a href="#" onclick='openKeywords("<?=$info["name"]?>", <?=json_encode($keywords)?>, this); return false;'><?=count($info["keywords"] ?? [])?></a></td>
                    <td class="emoji"><?=$likestring?></td>
                </tr><?
                
            }
        ?>
    </tbody>
</table>

<script type="text/javascript">

$('#library').dataTable({
    autoWidth: false,
    paging: false,
    dom: "t",
    order: [[1, "asc"]],
    columnDefs: [
        { targets: [4, 5, 6, 7], className: "ra"},
        { targets: [0, 8], orderable: false}
    ]
});

$("#library .hashcell > input").click(function () {
    $(this).select();
});

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

</script>

</body>
</html>

<?php

require_once("config.inc.php");
require_once("filters.php");

if (!defined('AJAX_REQUEST')) die();


$stats = json_decode(file_get_contents($statspath), true);


$ordercrit = [
     0 => "format",
     1 => "hash",
     2 => ["queuepos"],
     3 => "name",
     4 => "author",
     5 => "album",
     6 => "paddedtrack",
     7 => "paddedlength",
     8 => "allsharers",
     9 => ["plays"],
    10 => "paddedlastplayed",
    11 => ["kw"],
    12 => ["likenum"],
    13 => ["prioritymeta"]
];


//Use true for a standard match.
//Custom callbacks should return true if the search string matches the field.
$filterfields = [
    "hash" => true,
    "format" => true,
    "sharedBy" => function($pattern, $item) use ($stats) {
        foreach ($item["sharedBy"] as $userid) {
            if (preg_match($pattern, $userid)) return true;
            if ($stats["users"][$userid] && preg_match($pattern, $stats["users"][$userid]["displayname"])) return true;
        }
        return false;
    },
    "length" => true,
    "sourceSpecificId" => true,
    "name" => true,
    "author" => true,
    "album" => true,
    "track" => true,
    "keywords" => function($pattern, $item) {
        foreach ($item["keywords"] as $kw) {
            if (preg_match($pattern, $kw)) return true;
        }
        return false;
    },
    "like" => function($pattern, $item) use ($stats) {
        if (!isset($item["like"])) return false;
        foreach ($item["like"] as $userid => $like) {
            $ms = $userid . ":";
            if ($like > 0) $ms .= "+";
            $ms .= $like;
            if (preg_match($pattern, $ms)) return true;
            if ($stats["users"][$userid]) {
                $ms = $stats["users"][$userid]["displayname"] . ":";
                if ($like > 0) $ms .= "+";
                $ms .= $like;
                if (preg_match($pattern, $ms)) return true;
            }
        }
        return false;
    },
    "plays" => function($pattern, $item) use ($instancename) {
        if (!isset($item["radio." . $instancename . ".plays"])) return false;
        return preg_match($pattern, $item["radio." . $instancename . ".plays"]);
    },
    "novelty" => true
];



function hoursMinutesAndSeconds($seconds) {
    $h = floor($seconds / 3600);
    if ($h) {
        $seconds -= $h * 3600;
        $m = floor($seconds / 60);
        $s = $seconds % 60;
        return $h . ":" . str_pad($m, 2, "0", STR_PAD_LEFT) . ":" . str_pad($s, 2, "0", STR_PAD_LEFT);
    }
    return minutesAndSeconds($seconds);
}

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


$index = json_decode(file_get_contents($path), true);
$prefiltering = array_values($index);
$list = [];

$search = $_REQUEST["search"]["value"];
$highlightonly = false;
if (preg_match("/^@(.*)/", $search, $match)) {
    $highlightonly = true;
    $search = $match[1];
}

$filters = extractFilterTree(array_keys($filterfields), $search);
foreach ($prefiltering as $i => $item) {
    $accept = false;

    foreach ($filters as $filter) {
    
        $filtermatch = true;
    
        foreach ($filter["having"] as $element) {
            $not = false;
            if (isset($element[0])) {
                $not = true;
                $element = $element[1];
            }
            
            $elematch = false;
            foreach ($element as $field => $sstr) {
                if (!isset($filterfields[$field])) continue;
                $pattern = globToRegexPattern($sstr);
                if ($filterfields[$field] === true) {
                    $elematch = $elematch || preg_match($pattern, $item[$field]);
                } else {
                    $elematch = $elematch || $filterfields[$field]($pattern, $item);
                }
                if ($elematch) break;
            }
            
            if ($not) $elematch = !$elematch;
            $filtermatch = $filtermatch && $elematch;
            if (!$filtermatch) break;
        }
        
        if ($filtermatch) {
            foreach ($filter["regex"] as $element) {
                $not = false;
                if (isset($element[0])) {
                    $not = true;
                    $element = $element[1];
                }
                
                $elematch = false;
                foreach ($element as $field => $sstr) {
                    if (!isset($filterfields[$field])) continue;
                    $pattern = "/" . $sstr . "/i";
                    if ($filterfields[$field] === true) {
                        $elematch = $elematch || preg_match($pattern, $item[$field]);
                    } else {
                        $elematch = $elematch || $filterfields[$field]($pattern, $item);
                    }
                    if ($elematch) break;
                }
                
                if ($not) $elematch = !$elematch;
                $filtermatch = $filtermatch && $elematch;
                if (!$filtermatch) break;
            }
        }
        
        if ($filtermatch) {
            $accept = true;
            break;
        }
    
    }

    if ($highlightonly) {
        if ($accept) $item["highlight"] = true;
        $list[] = $item;
    } else if ($accept) {
        $list[] = $item;
    }
}

if (!count($filters)) $list = $prefiltering;


$data = [];

$totlength = 0;
$hllength = 0;
$hltotal = 0;
foreach ($list as $info) {

    $likes = $info["like"] ?? [];
    $likenum = 15000;
    foreach ($likes as $userid => $lik) {
        $likenum += $lik;
    }
    
    $plength = str_pad($info["length"], 5, "0", STR_PAD_LEFT);
    $totlength += $info["length"];
    if (isset($info["highlight"])) {
        $hllength += $info["length"];
        $hltotal += 1;
    }
    
    $ptrack = str_pad($info["track"] ?? 0, 3, "0", STR_PAD_LEFT);
    
    $allsharers = [];
    foreach ($info["sharedBy"] as $sharer) {
        $allsharers[] = $stats["users"][$sharer]["displayname"];
        if (isset($info["like"])) foreach ($info["like"] as $userid => $lik) {
            if ($userid == $sharer && $lik > 0) {
                $stats["users"][$sharer]["likeshares"] = ($stats["users"][$sharer]["likeshares"] ?? 0) + 1;
                break;
            }
        }
    }
    $allsharers = implode(", ", $allsharers);
    
    $keywords = array_map(function($keyword) { return htmlspecialchars(str_replace("'", "", $keyword)); }, $info["keywords"]);
    
    $info["name"] = htmlspecialchars($info["name"]);
    $info["author"] = htmlspecialchars($info["author"]);
    $info["album"] = htmlspecialchars($info["album"] ?? "");
    
    $lastplayedmeta = str_pad(0, strlen(PHP_INT_MAX), "0", STR_PAD_LEFT);
    if (isset($info["radio." . $instancename . ".lastplayed"])) {
        $lastplayedmeta = str_pad($info["radio." . $instancename . ".lastplayed"], strlen(PHP_INT_MAX), "0", STR_PAD_LEFT);
    }
    
    $queuepos = null;
    $queueuser = null;
    foreach ($stats["radio." . $instancename . ".queue"] as $i => $queueitem) {
        if ($queueitem["hash"] == $info["hash"]) {
            $queuepos = $i + 1;
            $queueuser = $queueitem["userid"];
            break;
        }
    }
    
    $data[] = [
        "format" => $info["format"] ?? "mp3",
        "hash" => $info["hash"],
        "name" => $info["name"],
        "source" => $info["source"],
        "author" => $info["author"],
        "urlauthor" => urlencode($info["author"]),
        "album" => $info["album"],
        "paddedtrack" => $ptrack,
        "track" => $info["track"] ?? "",
        "urlalbum" => urlencode($info["author"] . " " . $info["album"]),
        "paddedlength" => $plength,
        "length" => minutesAndSeconds($info["length"]),
        "sharedBy" => $info["sharedBy"][0],
        "allsharers" => $allsharers,
        "plays" => $info["radio." . $instancename . ".plays"] ?? 0,
        "paddedlastplayed" => $lastplayedmeta,
        "lastplayed" => ago($info["radio." . $instancename . ".lastplayed"] ?? 0),
        "kwlist" => $info["keywords"] ?? [],
        "kw" => count($info["keywords"] ?? []),
        "likes" => $likes,
        "likenum" => $likenum,
        "priority" => number_format($stats["radio." . $instancename . ".latestpriorities"][$info["hash"]] ?? 0, 1, ".", ""),
        "prioritymeta" => $stats["radio." . $instancename . ".latestpriorities"][$info["hash"]] ?? 0,
        "highlight" => isset($info["highlight"]),
        "novelty" => in_array($info["hash"], $stats["radio." . $instancename . ".latestnovelties"]),
        "queuepos" => $queuepos,
        "queueuser" => $queueuser
    ];
        
}


foreach ($_REQUEST["order"] as $order) {
    usort($data, function ($a, $b) use ($order, $ordercrit) {
        $crit = $ordercrit[$order["column"]];
        if ($order["dir"] == "asc") {
            if (is_array($crit)) {
                if ($a[$crit[0]] < $b[$crit[0]]) return 1;
                if ($a[$crit[0]] > $b[$crit[0]]) return -1;
            } else {
                return strcasecmp($a[$crit], $b[$crit]);
            }
        } else {
            if (is_array($crit)) {
                if ($a[$crit[0]] > $b[$crit[0]]) return 1;
                if ($a[$crit[0]] < $b[$crit[0]]) return -1;
            } else {
                return strcasecmp($b[$crit], $a[$crit]);
            }
        }
        return 0;
    });
}


$result["draw"] = $_REQUEST["draw"] * 1;
$result["data"] = $data;
$result["recordsTotal"] = count($index);
$result["recordsFiltered"] = count($data);

$result["totalLength"] = hoursMinutesAndSeconds($totlength);

$result["userstats"] = $stats["users"];
$result["playing"] = $stats["radio." . $instancename . ".playing"];

if ($highlightonly) {
    $result["highlights"] = [
        "length" => hoursMinutesAndSeconds($hllength),
        "lengthPct" => number_format($hllength / $totlength * 100, 1, ".", ""),
        "total" => $hltotal,
        "totalPct" => number_format($hltotal / count($data) * 100, 1, ".", "")
    ];
}

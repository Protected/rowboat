<?php

$path = "/PATH/TO/index.json";

?>

<html>
<head>
<title>Rajio library contents</title>
<style type="text/css">
body {
    padding: 0;
    margin: 0;
}
table {
    font-family: monospace;
    border-collapse: collapse;
    width: 100%;
}
th {
    text-align: left;
    border-bottom: 2px solid black;
}
tr.odd {
    background-color: #e0e0ff;
}
tr.even {
    background-color: #f0f0ff;
}
th, td {
    padding: 5px;
}
</style>
</head>
<body>

<?

$index = json_decode(file_get_contents($path), true);
$sorted = array_values($index);
usort($sorted, function ($a, $b) {
    return strcmp($a["name"], $b["name"]);
});

?>

<table>
    <thead>
        <tr>
            <th style="width: 260px;">Hash</th>
            <th>Name</th>
            <th>Author</th>
            <th style="width: 160px;">Likes</th>
        </tr>
    </thead>
    <tbody>
        <?
            foreach ($sorted as $i => $info) {
                $likestring = "";
                foreach ($info["like"] as $userid => $lik) {
                    if ($lik == 2) $likestring .= "👌 ";
                    if ($lik == 1) $likestring .= "🙂 ";
                    if ($lik == -1) $likestring .= "🙁 ";
                    if ($lik == -2) $likestring .= "💩 ";
                }
                ?><tr class="<?=($i % 2 ? "odd" : "even")?>"><td><?=$info["hash"]?></td><td><?=$info["name"]?></td><td><?=$info["author"]?></td><td><?=$likestring?></td></tr><?
            }
        ?>
    </tbody>
</table>

</body>
</html>

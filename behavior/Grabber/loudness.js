import ffmpeg from 'ffmpeg-static';
import cp from 'child_process';

export function analyzeVolume(audiofile) {
    return new Promise((resolve, reject) => {
        cp.exec(`${ffmpeg} -hide_banner -nostats -i ${audiofile} -filter_complex volumedetect -f null - 2>&1`, (error, result) => {
            if (error) {
                reject(error);
            } else {
                let mean_volume = parseFloat(result.match(/mean_volume: ([0-9.-]+) dB/)?.[1]);
                let max_volume = parseFloat(result.match(/max_volume: ([0-9.-]+) dB/)?.[1]);
                resolve({mean_volume, max_volume});
            }
        });
    });
}

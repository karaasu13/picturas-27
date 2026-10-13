import sys
import os
import json
import math
import subprocess
import datetime
import pytz
from utils.tool_msg import ToolMSG
import utils.env as env

# Limites do fator de velocidade (RN3) e timeout de processamento (E1).
# Podem ser ajustados por variáveis de ambiente no docker-compose.
MIN_SPEED = float(os.getenv('VIDEO_SPEED_MIN', '0.25'))
MAX_SPEED = float(os.getenv('VIDEO_SPEED_MAX', '4.0'))
TIMEOUT_SECONDS = int(os.getenv('VIDEO_SPEED_TIMEOUT', '600'))


class VideoSpeedError(Exception):
    def __init__(self, code_key, message):
        super().__init__(message)
        self.code_key = code_key


class VideoSpeed:
    def __init__(self):
        self._tool_msg = ToolMSG('picturas-video-speed-tool-ms', 'video_speed', env.RABBITMQ_HOST, env.RABBITMQ_PORT, env.RABBITMQ_USERNAME, env.RABBITMQ_PASSWORD)
        self._counter = 0
        self._codes = {
            # 3000+ para não colidir com os códigos das outras ferramentas (ex.: border usa 1200/1201)
            'wrong_procedure': 3000,
            'error_processing': 3001,
            'invalid_speed': 3002,
            'unsupported_format': 3003,
            'timeout': 3004
        }

    ######################################### lógica #########################################
    @staticmethod
    def validate_speed(speed):
        """RN3 / E4: o fator tem de ser numérico e estar dentro dos limites."""
        if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed):
            raise VideoSpeedError('invalid_speed', "The speed factor must be a number")
        if speed < MIN_SPEED or speed > MAX_SPEED:
            raise VideoSpeedError('invalid_speed', f"The speed factor must be between {MIN_SPEED}x and {MAX_SPEED}x")
        return float(speed)

    @staticmethod
    def atempo_chain(speed):
        """O filtro atempo do FFmpeg aceita 0.5-2.0 por instância (versões antigas),
        por isso fatores fora desse intervalo são decompostos numa cadeia."""
        filters = []
        while speed > 2.0:
            filters.append('atempo=2.0')
            speed /= 2.0
        while speed < 0.5:
            filters.append('atempo=0.5')
            speed /= 0.5
        filters.append(f'atempo={speed:.6f}')
        return ','.join(filters)

    def probe(self, path):
        """E2: valida que o ficheiro é um vídeo legível (e não uma imagem).
        Devolve True se tiver também pista de áudio."""
        if not os.path.isfile(path):
            raise VideoSpeedError('error_processing', "Input video not found")
        try:
            out = subprocess.run(
                ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type:format=format_name',
                 '-of', 'json', path],
                capture_output=True, text=True, timeout=30, check=True)
            info = json.loads(out.stdout)
        except (subprocess.SubprocessError, ValueError):
            raise VideoSpeedError('unsupported_format', "The video format or codec is not supported")
        streams = info.get('streams', [])
        format_name = info.get('format', {}).get('format_name', '')
        types = {s.get('codec_type') for s in streams}
        # png/jpeg/webp aparecem como "<x>_pipe" ou "image2"; gif é uma imagem para este efeito
        is_image = format_name.endswith('_pipe') or format_name in ('image2', 'gif')
        if 'video' not in types or is_image:
            raise VideoSpeedError('unsupported_format', "The file does not contain a supported video stream")
        return 'audio' in types

    def change_speed(self, input_path, output_path, speed):
        speed = self.validate_speed(speed)
        has_audio = self.probe(input_path)

        # O resultado é sempre MP4 (H.264/AAC). Se o nome pedido não termina em .mp4 (ex.: .mov, .avi),
        # acrescenta-se ".mp4". O Project Service usa o caminho que devolvemos (output.imageURI)
        # para guardar o ficheiro, deduzir o tipo MIME e encadear as ferramentas seguintes.
        final_path = output_path if output_path.lower().endswith('.mp4') else output_path + '.mp4'

        out_dir = os.path.dirname(final_path)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        tmp_path = final_path + '.part'  # escrita atómica: nunca fica um ficheiro a meio (REQ-010)

        cmd = ['ffmpeg', '-y', '-i', input_path, '-filter:v', f'setpts=PTS/{speed}']
        if has_audio:
            cmd += ['-filter:a', self.atempo_chain(speed), '-c:a', 'aac']
        else:
            cmd += ['-an']
        cmd += ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', '-f', 'mp4', tmp_path]

        try:
            subprocess.run(cmd, capture_output=True, timeout=TIMEOUT_SECONDS, check=True)
            os.replace(tmp_path, final_path)
        except subprocess.TimeoutExpired:
            raise VideoSpeedError('timeout', "The video processing timed out")
        except subprocess.CalledProcessError:
            raise VideoSpeedError('error_processing', "An error occured while processing the request")
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        return final_path

    ######################################### mensagens #########################################
    def _elapsed_ms(self, start):
        now = datetime.datetime.now(pytz.utc)
        return now.isoformat(), (now - start).total_seconds() * 1000

    def _reply_error(self, msg_id, resp_msg_id, start, code_key, message, input_path):
        cur_timestamp, processing_time = self._elapsed_ms(start)
        # argumentos por nome: a assinatura de send_msg tem o parâmetro "type" antes de err_code
        self._tool_msg.send_msg(msg_id, resp_msg_id, cur_timestamp, 'error', processing_time, None,
                                err_code=self._codes[code_key], err_msg=message, og_img_uri=input_path)

    def video_speed_callback(self, ch, method, properties, body):
        info = json.loads(body.decode())

        msg_id = info['messageId']
        timestamp = datetime.datetime.fromisoformat(info['timestamp'])
        procedure = info['procedure']
        params = info.get('parameters', {})
        input_path = params.get('inputImageURI')
        output_path = params.get('outputImageURI')
        speed = params.get('speed')

        resp_msg_id = f'video_speed-{self._counter}-{msg_id}'
        self._counter += 1

        if procedure != 'video_speed':
            self._reply_error(msg_id, resp_msg_id, timestamp, 'wrong_procedure',
                              "The procedure received does not fit into this tool", input_path or '')
            return

        try:
            final_path = self.change_speed(input_path, output_path, speed)

            cur_timestamp, processing_time = self._elapsed_ms(timestamp)
            self._tool_msg.send_msg(msg_id, resp_msg_id, cur_timestamp, 'success', processing_time,
                                    final_path, type='video')
        except VideoSpeedError as e:
            self._reply_error(msg_id, resp_msg_id, timestamp, e.code_key, str(e), input_path or '')
        except Exception:
            self._reply_error(msg_id, resp_msg_id, timestamp, 'error_processing',
                              "An error occured while processing the request", input_path or '')

    def exec(self, args):
        while True:
            self._tool_msg.read_msg(self.video_speed_callback)


if __name__ == "__main__":
    video_speed = VideoSpeed()
    video_speed.exec(sys.argv)

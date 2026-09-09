# EC2 t3.micro 배포

대상은 Ubuntu 22.04/24.04 또는 Amazon Linux 2023을 실행하는 `t3.micro`입니다. 앱은 Docker Compose로 실행하고, 업로드 데이터는 별도 EBS를 `/srv/tissue-uploader/data`에 마운트합니다.

## AWS에서 먼저 설정

1. 일반 자동 할당 퍼블릭 IP는 중지/시작 후 바뀔 수 있습니다. Elastic IP를 연결합니다.
2. 인스턴스와 같은 가용 영역에 EBS `gp3` 볼륨을 생성해 연결합니다. 평균 1.9MB 사진 5만 장은 원본만 약 95GB이므로, 썸네일·DB·여유 공간을 포함해 150GB를 권장합니다. EBS와 스냅샷에는 AWS 요금이 발생할 수 있습니다.
3. 보안 그룹 인바운드는 TCP 80/443을 전체에 허용하고, TCP 22는 관리자의 현재 IP로 제한합니다. 3000번 포트는 열지 않습니다.
4. 도메인 DNS A 레코드를 Elastic IP로 연결합니다. Caddy가 공개 인증서를 발급하고 HTTP를 HTTPS로 전환합니다.

AWS 공식 문서: [EBS 연결](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-attaching-volume.html), [EBS 포맷과 자동 마운트](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-using-volumes.html), [보안 그룹 예시](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-rules-reference.html)

## EBS 최초 1회 마운트

먼저 `lsblk -f`로 새 빈 디스크 이름을 확인합니다. Nitro 기반 EC2에서는 콘솔에서 `/dev/sdf`로 연결해도 서버에는 `/dev/nvme1n1`처럼 표시될 수 있습니다. 아래 `DEVICE`에는 확인한 새 빈 EBS 장치를 넣습니다. `mkfs`는 기존 데이터를 지우므로 기존 파일시스템이 있는 장치에는 실행하면 안 됩니다.

```sh
lsblk -f
DEVICE=/dev/nvme1n1
sudo file -s "$DEVICE"
sudo mkfs.ext4 "$DEVICE"
sudo mkdir -p /srv/tissue-uploader/data
sudo mount "$DEVICE" /srv/tissue-uploader/data
sudo chown -R 1000:1000 /srv/tissue-uploader
sudo blkid "$DEVICE"
```

`blkid`에 표시된 UUID를 사용해 `/etc/fstab`에 다음 형식으로 추가한 뒤 `sudo mount -a`가 오류 없이 끝나는지 확인합니다.

```text
UUID=실제-UUID /srv/tissue-uploader/data ext4 defaults,nofail 0 2
```

## Docker와 앱 실행

Docker Engine과 Compose 플러그인을 설치하고 프로젝트를 `/opt/tissue-uploader`에 복사합니다. `.env.ec2.example`을 `.env.ec2`로 복사해 실제 도메인과 관리자 비밀번호를 지정합니다. `.env.ec2`는 외부에 전달하거나 Git에 올리지 않습니다.

```sh
docker version
docker compose version
cd /opt/tissue-uploader
cp .env.ec2.example .env.ec2
nano .env.ec2
sudo mkdir -p /srv/tissue-uploader/data
sudo chown -R 1000:1000 /srv/tissue-uploader/data
docker compose -f compose.ec2.yml up -d --build
docker compose -f compose.ec2.yml ps
docker compose -f compose.ec2.yml logs --tail=100 app caddy
curl -fsS https://실제도메인/healthz
```

업로드 화면은 `https://실제도메인/`, 관리자 화면은 `https://실제도메인/admin`입니다.

## t3.micro 메모리 설정

`t3.micro`는 2 vCPU, 메모리 1GiB입니다. 이 배포 파일은 Node 힙을 384MB로 제한하고, 이미지 변환을 한 번에 1개, 브라우저 업로드를 한 번에 2개씩 처리합니다. 사용자는 30장을 한 번에 선택할 수 있으며 두 장씩 완료되는 대로 다음 사진이 전송됩니다. 여러 의료기관이 동시에 큰 사진을 다수 올리면 느려지거나 메모리가 부족할 수 있습니다. 메모리 부족 재시작이 나타나면 `t3.small` 이상이나 원본 직접 S3 업로드 구조로 전환해야 합니다.

## 상태 확인과 백업

```sh
df -h /srv/tissue-uploader/data
free -h
docker stats --no-stream
docker compose -f compose.ec2.yml logs --tail=200 app
docker compose -f compose.ec2.yml up -d --build
```

DB와 원본은 모두 `/srv/tissue-uploader/data` 아래 있습니다. EBS 스냅샷을 정기 생성하고 복원 절차도 한 번 확인해야 합니다. 대규모 전체 ZIP은 날짜나 의료기관별로 나눠 받는 편이 안정적입니다.

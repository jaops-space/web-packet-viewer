#!/bin/bash
set -e

cd `dirname $0`/..
home=`pwd`

if [[ -n $(git status -s) ]]; then
    read -p 'Your workspace contains dirty or untracked files. These will not be part of your release. Continue? [Y/n] ' yesNo
    if [[ -n $yesNo ]] && [[ $yesNo == 'n' ]]; then
        exit 0
    fi
fi

# Sets the version of the plugin and of the development Yamcs (which depends on it)
setVersion() {
    for pom in plugin dev/yamcs; do
        mvn -q -f $pom versions:set -DnewVersion=$1 -DgenerateBackupPoms=false
    done
}

pomversion=`mvn -q -f plugin help:evaluate -Dexpression=project.version -DforceStdout`
read -p "Enter the new version to set [$pomversion] " newVersion
if [[ -n $newVersion ]]; then
    pomversion=$newVersion
    setVersion $newVersion
fi

if [[ $pomversion == *-SNAPSHOT ]]; then
    snapshot=1
    version=${pomversion/-SNAPSHOT/}
else
    snapshot=0
    version=$pomversion
fi

if [[ -n $(git status -s) ]]; then
    git commit . -v -em"Prepare release web-packet-viewer-${version}" || :
    if [ $snapshot -eq 0 ]; then
        git tag web-packet-viewer-$version
    fi
fi

mvn -q -f plugin clean

clonedir=$home/distribution/target/web-packet-viewer-clone

rm -rf $clonedir
mkdir -p $clonedir
git clone . $clonedir
rm -rf $clonedir/.git

# The web UI (with the WebAssembly worker) goes into the plugin jar
cd $clonedir/web
npm ci
npm run wasm
npm run build

cd $clonedir/plugin
mvn package -P jaops-release -DskipTests

cd $home

jar=`ls $clonedir/plugin/target/web-packet-viewer-$pomversion.jar`
if ! unzip -l $jar | grep -q packet-viewer-web/web-packet-viewer.js; then
    echo "The web UI is missing from $jar"
    exit 1
fi

ls -lh $clonedir/plugin/target/*.jar
echo

if [ $snapshot -eq 0 ]; then
    read -p "Do you want to upload $pomversion maven artifacts to Maven Central? [y/N] " yesNo
    if [[ $yesNo == 'y' ]]; then
        mvn -f $clonedir/plugin -P jaops-release -DskipTests deploy
        echo 'Check and publish the deployment at https://central.sonatype.com/publishing/deployments'
    fi
else
    # Requires SNAPSHOTs to be enabled for the com.jaops namespace in the Central Portal
    read -p "Do you want to publish $pomversion maven artifacts to Maven Central Snapshots? [y/N] " yesNo
    if [[ $yesNo == 'y' ]]; then
        mvn -f $clonedir/plugin -P jaops-release -DskipTests deploy
    fi
fi

rm -rf $clonedir

# Upgrade version in pom.xml files
# For example: 1.2.3 --> 1.2.4-SNAPSHOT
if [ $snapshot -eq 0 ]; then
    if [[ $version =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
        developmentVersion=${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))-SNAPSHOT
        setVersion $developmentVersion
        git commit . -v -em"Prepare next development iteration"
    else
        echo 'Failed to set development version'
        exit 1
    fi
fi
